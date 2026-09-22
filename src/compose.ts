/**
 * The interactive ACP server app composition: the default agent spine
 * ({@link @deepseek-ai/dsh-agent-spine-demo}), JSONL session persistence, the
 * derived query engine, and the {@link dsh-acp-interactive} transport. This
 * mirrors the official {@link @deepseek-ai/dsh-acp-demo} composition, swapping
 * the automation-only transport for the interactive one. The composite effect
 * unloads in reverse order, keeping checkpoint and persistence listeners
 * attached until ACP sessions quiesce before persistence detaches. It writes
 * nothing to stdout.
 * @module dsh-acp-interactive/app
 */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import * as interactive from './index.ts'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions'
import ToolRuntime, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence, {
  JsonlCompressionSchema,
  type JsonlCompression,
} from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'

export const name = 'acp-interactive-app'
const DEFAULT_PERSISTENCE_ROOT = './.sessions'

/** App config: swappable per-deployment values, mirroring `dsh-acp-demo`. */
export interface Config {
  /** Provider route for ACP-created agents. */
  provider: string
  /** Model name for ACP-created agents (must have a registered adapter). */
  model: string
  /** Enable the interactive surface (session/list + load); default false. */
  interactive?: boolean
  /** Bundled agent-loop concurrency cap; `1` is serial and omission uses its default. */
  maxParallelToolCalls?: number
  /** Deployment persona (the system-prompt plugin's `persona` config). */
  persona?: string
  /** Explicit model-facing tool order. */
  toolOrder?: string[]
  /** Tool-registry config — its presentation `mode`. */
  tools?: ToolsConfig
  /** DeepSeek Harness home directory exposed to bash and used for local skill discovery. */
  dshHome?: string
  /** Fallback session-title limits forwarded through agent-spine-demo. */
  sessionTitle?: NonNullable<agentCore.Config['sessionTitle']>
  /** Directory for JSONL sessions and the derived query index. Defaults to `./.sessions`. */
  persistenceRoot?: string
  /** Write delta-chunk runs as packed storage rows. Defaults to `true`. */
  packChunks?: boolean
  /** JSONL artifact encoding; defaults to checksummed Zstandard frames. */
  persistenceCompression?: JsonlCompression
  /** Controls automatic AGENTS.md/CLAUDE.md loading. */
  workspaceContext: agentCore.Config['workspaceContext']
  /** Skill registry, local-provider, and model-facing consumer config. */
  skills?: agentCore.SkillConfig
  /** Model-facing bash tool config forwarded through agent-core. */
  toolBash?: NonNullable<agentCore.Config['toolBash']>
  /** Process-local background-job admission config forwarded through agent-core. */
  jobs?: NonNullable<agentCore.Config['jobs']>
  /** Generic background-job controls forwarded through agent-core. */
  toolJobs?: NonNullable<agentCore.Config['toolJobs']>
  /** Persisted same-session goals; owner defaults enable them, or false disables the stack and tools. */
  goals?: agentCore.GoalConfig | false
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  interactive: z.boolean().default(false),
  maxParallelToolCalls: z.number().step(1).min(1),
  persona: z.string(),
  toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  tools: ToolRuntime.Config,
  dshHome: z.string(),
  sessionTitle: agentCore.SessionTitleConfigSchema,
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  packChunks: z.boolean().default(true),
  persistenceCompression: JsonlCompressionSchema,
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
  skills: agentCore.SkillConfigSchema,
  toolBash: agentCore.ToolBashConfigSchema,
  jobs: agentCore.JobsConfigSchema,
  toolJobs: z.union([z.const(false), agentCore.ToolJobsConfigSchema]),
  goals: z.union([z.const(false), agentCore.GoalConfigSchema]),
})

/**
 * Compose the spine with the interactive ACP transport. The agent-spine-demo
 * bundle pre-creates no agents; the JSONL backend and derived query index
 * persist under `persistenceRoot`; the interactive bridge owns stdout for
 * JSON-RPC and creates/resumes one agent per `session/new` / `session/load`.
 * @param ctx - Cordis context.
 * @param config - deployment config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const goals = config.goals ?? {}
  const persistenceRoot = config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT
  await ctx.effect(async function* () {
    const spine = ctx.plugin(agentCore, { ...agentCore.pickSpineConfig(config), goals })
    await spine
    yield spine.dispose
    const persistence = ctx.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      ...config.packChunks !== undefined ? { packChunks: config.packChunks } : {},
      ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
    })
    await persistence
    yield persistence.dispose
    const checkpoint = ctx.plugin(sessionCheckpointPolicy)
    await checkpoint
    yield checkpoint.dispose
    const query = ctx.plugin(SqliteSessionQueryEngine, { path: join(persistenceRoot, 'session-query.db') })
    await query
    yield query.dispose
    const transport = ctx.plugin(interactive, {
      provider: config.provider,
      model: config.model,
      ...(config.interactive !== undefined ? { interactive: config.interactive } : {}),
    })
    await transport
    yield transport.dispose
  }, 'acp-interactive-app.composition')
}
