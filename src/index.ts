/**
 * Interactive Agent Client Protocol server for DeepSeek Harness.
 *
 * A drop-in superset of the official automation-only `@deepseek-ai/dsh-acp`
 * bridge: it adds `session/list` and `session/load` (resume) plus streaming
 * assistant output, by re-implementing the complete ACP `Agent` over the
 * public `AgentSideConnection` and the public agent-factory / session-
 * persistence APIs. The official `dsh-acp` plugin is NOT mounted; the
 * official packages stay untouched. Set `interactive: true` to advertise and
 * serve the interactive methods; the default false keeps automation semantics.
 *
 * @module dsh-acp-interactive
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type SessionInfo,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { AcpContentError, admitAcpPrompt, assistantBlockToAcp, supportsAcpImagePrompts } from './content.ts'
import { turnEndToStopReason } from './codec.ts'

export const name = 'acp-interactive'
/** The bridge creates and owns agents; every other concern is carried by the agent composition. */
export const inject = ['agents']

/**
 * The single continuable-subagent teardown the bridge needs. Declared
 * structurally so this package does not depend on the subagent seam for one
 * shutdown hook; an absent service means nothing continuable was materialized.
 */
interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: provider/model selection plus the interactive opt-in. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /**
   * Enable the interactive ACP surface: `session/list`, `session/load`, and
   * streaming assistant output. Default false keeps automation-only behavior.
   */
  interactive?: boolean
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  interactive: Schema.boolean().default(false),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** Ordered assistant-output delivery; every task contains its own failure. */
  outputTail: Promise<void>
  /** In-flight admission/turn/output lifecycle for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    /** Set only after rich-content admission succeeds and the message is built. */
    messageId: string | undefined
    /** Whether this prompt has entered the Agent's durable inbox interval. */
    messageQueued: boolean
    turn: number | undefined
    /** The correlated turn's ending, set at turn/end and settled at whole-agent idle. */
    endReason: TurnEndReason | undefined
    /** Admission quiescence gate, including any attachment write already in progress. */
    admissionDone: Promise<void>
    finishAdmission: () => void
    admissionController: AbortController
    cancelRequested: boolean
    settlementStarted: boolean
    /** Conversion failure for committed output owned by this prompt's turn. */
    outputError: Error | undefined
    /** Interval-wide failure outside the correlated turn. */
    agentError: Error | undefined
  } | undefined
}

/**
 * Mount the interactive ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - provider/model selection, interactive opt-in, and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  let closed = false
  let conn: AgentSideConnection
  let imagePromptEnabled = false

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send one ordered protocol update while containing transport-only failure. */
  const notify = async (notification: SessionNotification): Promise<void> => {
    try {
      await conn.sessionUpdate(notification)
    } catch (error: unknown) {
      logger.warn(`acp-interactive: session/update failed: ${String(error)}`)
    }
  }

  const rejectFromError = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: Extract<TurnEndReason, { kind: 'error' }>,
  ): void => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  /**
   * Settle one exact prompt only after admission, agent activity, and ordered
   * assistant delivery have all reached quiescence.
   */
  const settleAfterQuiescence = (
    record: SessionRecord,
    inflight: NonNullable<SessionRecord['inflight']>,
  ): void => {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await record.agent.whenIdle()
        await record.outputTail
      }
      if (record.inflight !== inflight) return
      record.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        rejectFromError(inflight, end)
      } else {
        inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
      }
    })()
      .catch((error: unknown) => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
  }

  // Deliver committed assistant text/images. Raw chunks, reasoning, tools,
  // plans, titles, and retry markers stay off the wire (automation semantics);
  // the interactive surface keeps the same committed-message contract for now,
  // streaming raw assistant text at message granularity rather than token.
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === 'assistant/message') {
        const inflight = record.inflight?.turn === event.data.turn ? record.inflight : undefined
        const previous = record.outputTail
        const delivery = previous.then(async () => {
          for (const block of event.data.message.content) {
            const content = await assistantBlockToAcp(ctx, block)
            if (content === undefined) continue
            await notify({
              sessionId: record.agent.session.id,
              update: { sessionUpdate: 'agent_message_chunk', content },
            })
          }
        })
        record.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          logger.warn(`acp-interactive: assistant output conversion failed: ${errorChain(error)}`)
        })
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || !inflight.messageQueued || inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    settleAfterQuiescence(record, inflight)
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  /** Map a persisted session header to the ACP session-info vocabulary. */
  const sessionHeaderToInfo = (header: { id: SessionId; cwd?: string }): SessionInfo => {
    // ACP requires an absolute `cwd`; a header without one (created before the
    // cwd was persisted) falls back to the process cwd rather than omitting it.
    return { sessionId: header.id, cwd: header.cwd ?? process.cwd() }
  }

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-acp-interactive', version: '0.1.0' },
          agentCapabilities: {
            promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
            // Interactive surface advertises the two resume/list methods only
            // when opted in; automation clients see an unchanged capability set.
            ...(config.interactive === true
              ? { loadSession: true, sessionCapabilities: { list: {} } }
              : {}),
          },
          authMethods: [],
        }
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          outputTail: Promise.resolve(),
          inflight: undefined,
        })
        return { sessionId }
      },

      async listSessions(_params: ListSessionsRequest): Promise<ListSessionsResponse> {
        assertOpen()
        // Union of persisted history and the live in-process sessions (which may
        // not have flushed a JSONL artifact yet, e.g. an empty session). Live
        // entries win on id; their `cwd` is the session meta recorded at create.
        const seen = new Map<string, SessionInfo>()
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const headers = await persistence.list()
          for (const header of headers) {
            seen.set(header.id, sessionHeaderToInfo(header))
          }
        }
        for (const [sessionId, record] of sessions) {
          if (!seen.has(sessionId)) {
            seen.set(sessionId, { sessionId, cwd: record.agent.session.header.cwd ?? process.cwd() })
          }
        }
        return { sessions: [...seen.values()] }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        assertOpen()
        const sessionId = SessionId(params.sessionId)
        if (sessions.has(sessionId)) {
          throw invalidParams(`session ${sessionId} is already loaded`)
        }
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          agentOptions: agentOptions(config),
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          outputTail: Promise.resolve(),
          inflight: undefined,
        })
        // The ACP load contract streams the previous conversation back to the
        // client; replay committed assistant messages for the resumed session.
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          const inspection = await persistence.load(sessionId)
          for (const event of inspection.events) {
            if (event.type !== 'assistant/message') continue
            for (const block of event.data.message.content) {
              const content = await assistantBlockToAcp(ctx, block)
              if (content === undefined) continue
              await notify({
                sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content },
              })
            }
          }
        }
        return {}
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        const completion = Promise.withResolvers<StopReason>()
        const admission = Promise.withResolvers<void>()
        const admissionController = new AbortController()
        const inflight: NonNullable<SessionRecord['inflight']> = {
          resolve: completion.resolve,
          reject: completion.reject,
          messageId: undefined,
          messageQueued: false,
          turn: undefined,
          endReason: undefined,
          admissionDone: admission.promise,
          finishAdmission: admission.resolve,
          admissionController,
          cancelRequested: false,
          settlementStarted: false,
          outputError: undefined,
          agentError: undefined,
        }
        record.inflight = inflight

        let admissionFailure: unknown
        try {
          if (ctx.agents.get(record.agent.id) !== record.agent) {
            throw internalError('prompt was not queued: the agent was disposed outside the bridge')
          }
          const content = await admitAcpPrompt(
            ctx,
            record.agent,
            params.prompt,
            imagePromptEnabled,
            admissionController.signal,
          )
          admissionController.signal.throwIfAborted()
          if (ctx.agents.get(record.agent.id) !== record.agent) {
            throw internalError('prompt was not queued: the agent was disposed outside the bridge')
          }
          const message = createUserMessage({ content, source: { kind: 'user' } })
          inflight.messageId = message.id
          inflight.messageQueued = true
          try {
            record.agent.followup(message)
          } catch (error: unknown) {
            inflight.messageQueued = false
            throw error
          }
        } catch (error: unknown) {
          admissionFailure = error
        } finally {
          inflight.finishAdmission()
        }

        if (inflight.cancelRequested) {
          settleAfterQuiescence(record, inflight)
          return { stopReason: await completion.promise }
        }
        if (admissionFailure !== undefined) {
          record.inflight = undefined
          const failure: unknown = admissionFailure
          if (failure instanceof AcpContentError) {
            throw failure.kind === 'invalid'
              ? invalidParams(failure.message)
              : internalError(failure.message)
          }
          if (failure instanceof RequestError) throw failure
          const detail = (failure as Error).message
          throw internalError(`prompt was not queued: ${detail}`)
        }

        settleAfterQuiescence(record, inflight)
        const stopReason = await completion.promise
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        const inflight = record.inflight
        if (inflight !== undefined) {
          inflight.cancelRequested = true
          inflight.admissionController.abort(new Error('ACP prompt cancelled'))
          settleAfterQuiescence(record, inflight)
        }
        if (inflight === undefined || inflight.messageQueued) record.agent.cancel({ kind: 'user' })
        return Promise.resolve()
      },
    }
  }

  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      const inflight = record.inflight
      if (inflight !== undefined) {
        inflight.cancelRequested = true
        inflight.admissionController.abort(new Error('ACP bridge disposed'))
        settleAfterQuiescence(record, inflight)
      }
      record.agent.cancel({ kind: 'user' })
    }
    quiescing = (async () => {
      await Promise.all(records.map(async (record) => {
        await record.inflight?.admissionDone
        await record.agent.whenIdle()
        await record.outputTail
      }))
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`acp-interactive: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`acp-interactive: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp-interactive: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'acp-interactive.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/** Reject session features outside the automation contract. */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}
