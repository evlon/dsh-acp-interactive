# dsh-acp-interactive

Interactive ACP server for DeepSeek Harness — a drop-in superset of the official
automation-only `@deepseek-ai/dsh-acp` bridge, adding `session/list` and
`session/load` (resume) so IDE-style clients (e.g. HiCoding) can restore prior
conversations.

The official `deepseek-harness` packages stay untouched: this package re-implements
the complete ACP `Agent` over the public `@agentclientprotocol/sdk`
`AgentSideConnection` and the public agent-factory / session-persistence APIs.

## Install

Published to the public npm registry as the **unscoped** package
`dsh-acp-interactive` (no `@deepseek-ai/` scope — unlike every official
`@deepseek-ai/dsh-*` package):

```sh
npm i dsh-acp-interactive
```

Current published version: `0.1.0` (`latest`). After install, the
`dsh-acp-interactive` binary is available on `PATH`; it also exposes a
programmatic API (`dsh-acp-interactive/app`, `dsh-acp-interactive/bin`).

> **Runtime dependency note:** `dsh-acp-interactive` depends on
> `@agentclientprotocol/sdk@0.25.1` (exact) and declares
> `@deepseek-ai/dsh-*@^0.1.1-rc.2` as peer dependencies — the same `0.1.1-rc.2`
> line the official bridge used. On the public npm registry these resolve
> automatically; on an internal mirror (e.g. a private Verdaccio), those
> transitive/peer packages must be mirrored first.

## What it adds

| ACP method | Official `dsh-acp` | This package |
|---|---|---|
| `session/new` | ✅ | ✅ |
| `session/prompt` | ✅ | ✅ |
| `session/cancel` | ✅ | ✅ |
| `session/list` | ❌ | ✅ (when `interactive: true`) |
| `session/load` | ❌ | ✅ (when `interactive: true`) |

Streaming assistant output and tool/thought display are delivered at committed
message granularity (the official bridge's contract), not token-level.

## Usage

```sh
dsh-acp-interactive --config cordis.yml
```

The bin boots a stdio JSON-RPC ACP server from `cordis.yml` (default `./cordis.yml`).
Stdout is reserved for JSON-RPC; diagnostics go to stderr.

Config (`cordis.yml`, `acp-agent` entry):

```yaml
- id: acp-agent
  name: 'dsh-acp-interactive/app'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    interactive: true          # enable session/list + session/load
    persistenceRoot: ./.sessions
```

## Config reference

| Key | Meaning | Default |
|---|---|---|
| `provider` | Provider route for created agents (required) | — |
| `model` | Model name for created agents (required) | — |
| `interactive` | Advertise and serve `session/list` + `session/load` | `false` |
| `persistenceRoot` | JSONL session directory | `./.sessions` |
| `persona` | Deployment persona | `''` |
| `workspaceContext` | AGENTS.md/CLAUDE.md loader budget, or `false` | required |

## Known Limitations and Deferred Work

- Streaming is committed-message granularity, not token-level; raw chunks,
  reasoning, tools, plans, and titles stay off the wire (automation contract).
- `session/list` returns the union of persisted history and live in-process
  sessions; `session/load` resumes only a persisted (flushed) session — an empty
  session with no completed turn does not yet produce a JSONL artifact, so it is
  only listed while its process is live.
- `session/load` replays committed assistant messages but does not reconstruct
  user messages or tool calls into the client history.
- HiCoding provider wiring (`acp.providers` entry + sandbox `ALLOWED_COMMANDS`)
  is out of scope here and lands in a separate integration step.
