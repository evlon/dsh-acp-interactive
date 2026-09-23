// 改进版：捕获 server 主动推送的 session/update notification（agent_message_chunk）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const API_KEY = process.env.DEEPSEEK_API_KEY ?? 'apikey-bf6a86a126a846ca81b869b398513c19'

const child = spawn(process.execPath, ['lib/bin.js', '--config', 'cordis.yml'], {
  cwd: process.cwd(),
  env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const pending = new Map()
let nextId = 1
let assistantText = ''
let toolCalls = []

const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  // 响应
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  // notification（server 主动推送）
  if (msg.method === 'session/update') {
    const u = msg.params?.update
    if (u?.sessionUpdate === 'agent_message_chunk') {
      const c = u.content
      if (c?.type === 'text') { assistantText += c.text; process.stdout.write('[文本] ' + c.text + '\n') }
      else process.stdout.write('[chunk] ' + JSON.stringify(c) + '\n')
    } else if (u?.sessionUpdate === 'tool_call') {
      toolCalls.push(u)
      process.stdout.write('[工具调用] ' + JSON.stringify(u).slice(0, 200) + '\n')
    } else {
      process.stdout.write('[notification] ' + JSON.stringify(msg.params).slice(0, 200) + '\n')
    }
  }
})

function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 90000)
  })
}

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()))

try {
  await send('initialize', { protocolVersion: 1, clientInfo: { name: 'smoke', version: '1.0' } })
  const sess = await send('session/new', { cwd: process.cwd(), mcpServers: [] })
  console.log('=== 开始 prompt，等待真实推理... ===')
  const r = await send('session/prompt', {
    sessionId: sess.sessionId,
    prompt: [{ type: 'text', text: '请用一句话回答：中国的首都是哪里？' }],
  })
  console.log('=== prompt 返回 ===', JSON.stringify(r))
  console.log('=== 累计 assistant 文本 ===', JSON.stringify(assistantText))
  console.log('=== 工具调用次数 ===', toolCalls.length)
  if (assistantText.trim().length > 0) {
    console.log('\n✅ 真推理验证通过：模型通过公司网关返回了真实文本')
  } else {
    console.log('\n❌ 未捕获到模型文本，真推理可能未发生')
    process.exitCode = 1
  }
} catch (e) {
  console.error('=== 失败 ===', e.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 2000)
}
