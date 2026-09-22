# dsh-acp-interactive 设计文档

> 让 DeepSeek Harness 成为 HiCoding 交互式 CLI（方案 B）—— 官方仓库零改动，独立消费仓实现。

## 0. 结论摘要

官方 `@deepseek-ai/dsh-acp` 是 **automation-only**（无头）ACP server：只实现了
`initialize` / `newSession` / `prompt` / `cancel` / `authenticate`，**缺失**
`session/list` / `session/load` / 流式 / 工具展示 / 思考展示 / elicitation。

本仓 `dsh-acp-interactive` 在**不改官方一行代码**的前提下，用官方公开 API 重新实现
一个「完整交互式 ACP agent」，补齐上述能力，供 HiCoding 等 IDE 客户端拉起。

## 1. 关键事实（全部源码实测）

### 1.1 官方 dsh-acp 的能力边界

`packages/acp/acp/src/index.ts` 的 `makeAgent()` 返回的 `AcpAgent` 只实现：

- `initialize`：只声明 `promptCapabilities`（image/audio/embeddedContext），
  **无 `sessionCapabilities` / `toolCapabilities` / `elicitationCapabilities`**。
- `newSession`：`sessionId = SessionId(randomUUID())`，**硬编码新建，忽略客户端
  sessionId**；拒绝 `mcpServers` / `additionalDirectories`。
- `prompt`：把客户端 prompt 转成 user message 入 agent inbox，等 idle 后
  **只发 committed 的 `agent_message_chunk`**（无 token 级流式、无
  `agent_thought_chunk`、无 `tool_call`）。
- `cancel` / `authenticate`：空实现。

### 1.2 ACP SDK 的协议层天然支持「可选交互方法」

`@agentclientprotocol/sdk` 的 `Agent` 接口中，`loadSession` / `listSessions` /
`resumeSession` / `deleteSession` / `closeSession` / `setSessionMode` 等**全是
可选方法**（`?`），且各有对应的 capability 声明字段。这意味着「agent 自己实现
这些方法 + 在 `initialize` 里声明 capability」是协议设计的正路，无需改动 SDK 或官方。

### 1.3 官方暴露的可复用 API（本仓依赖的全部）

| API | 位置 | 用途 |
|---|---|---|
| `ctx.agents.create({ sessionId, meta, agentOptions })` | `dsh-agent` AgentRegistry | 新建 session + agent |
| `ctx.agents.resume({ resumeSessionId, agentOptions })` | `dsh-agent` AgentRegistry | 恢复已持久化 session |
| `ctx.sessionPersistence.list()` | `dsh-session-persistence` | `session/list` 的会话清单 |
| `ctx.sessionPersistence.load(id)` | 同上 | `session/load` 的历史恢复 |
| `ctx.on('session/event', ...)` | cordis 事件 | 流式/工具/思考展示的数据源 |
| `AgentSideConnection` | `@agentclientprotocol/sdk` | 独立可实例化的 agent-side 连接 |
| `ndJsonStream` | 同上 | stdio JSON-RPC 流 |

### 1.4 官方 dsh-acp 的 `apply()` 焊死了 `AgentSideConnection`

`dsh-acp` 的 `apply()` 内部 `new AgentSideConnection(makeAgent, stream)` 且不暴露
`makeAgent` 或 `Agent` 对象。因此**独立仓无法「在官方 connection 上补方法」**，
唯一干净路径是：**不复用官方 `dsh-acp` 插件，独立仓自己 `new AgentSideConnection`，
实现完整 `Agent`**。这正是方案 A（真·零改官方）。

## 2. 架构

```
HiCoding /coding 页面
   │  WebSocket → 沙箱拉起 CLI
   ▼
dsh-acp-interactive --config cordis.yml   (bin)
   │  boot() 挂载 cordis.yml
   ▼
interactive plugin (本仓 src/index.ts)
   │  自己 new AgentSideConnection(makeAgent, ndJsonStream(stdio))
   │  makeAgent 实现完整 Agent（含 loadSession/listSessions）
   │
   ├─ ctx.agents.create / resume    → 建/恢复 agent
   ├─ ctx.sessionPersistence.list   → session/list
   ├─ ctx.sessionPersistence.load   → session/load 历史
   └─ ctx.on('session/event')       → 流式 agent_message_chunk /
   │                                   agent_thought_chunk / tool_call
```

## 3. 实现清单

### 3.1 `interactive` 开关（AcpConfig）

```ts
interface InteractiveAcpConfig {
  provider?: string
  model?: string
  /** 开启交互式（session/list + load + 流式 + 工具/思考）；默认 false = automation-only */
  interactive?: boolean
}
```

- `interactive=false`（默认）：行为与官方 `dsh-acp` 一致（仅 committed 文本）。
- `interactive=true`：声明 `sessionCapabilities`（listSessions/loadSession），
  实现 `listSessions`/`loadSession`，并升级流式为 token 级 + 工具/思考。

### 3.2 补齐的协议方法

| 方法 | 实现 |
|---|---|
| `initialize` | 声明 `sessionCapabilities: { listSessions, loadSession }`（interactive 时）|
| `listSessions` | `ctx.sessionPersistence.list()` → 映射 `SessionInfo[]` |
| `loadSession` | `ctx.agents.resume({ resumeSessionId })` + 回放历史事件 |
| `prompt` | 复用官方 admission 逻辑（`admitAcpPrompt` + `assistantBlockToAcp`）|
| 流式 | 监听 `session/event`，增量发 `agent_message_chunk` |

### 3.3 cordis.yml

复用官方 `examples/acp-agent/cordis.yml` 的 spine（agent-spine-demo + JSONL
persistence + query engine），但把 `acp` 插件替换为本仓 `interactive` 插件。

## 4. 可配置开启（HiCoding 侧，后续单独做）

不在本仓范围。但接口预留：HiCoding `acp.providers` 加 `deepseek-harness` 条目即开启，
沙箱 `ALLOWED_COMMANDS` 白名单做第二道闸。详见
`iteration/reports/设计-让dsh成为HiCoding交互式CLI-方案B.md`。

## 5. 待办 / 决策记录

- [x] 官方零改动（方案 A：独立仓自己 new AgentSideConnection）
- [x] 仓名 `dsh-acp-interactive`
- [x] `interactive` 布尔开关，默认 false
- [ ] 本仓代码实现（src/index.ts + bin.ts + cordis.yml）
- [ ] 本地验证（tsc + 冒烟：启动后 `session/list` 返回空清单）
- [ ] HiCoding 配置接入（另立项）
