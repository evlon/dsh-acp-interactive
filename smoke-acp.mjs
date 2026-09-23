// 最小真推理验证：通过 stdio 驱动 dsh-acp-interactive，走公司网关真推理。
// 用法: node smoke-acp.mjs  (在 dsh-acp-interactive 目录，需已 build)
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const API_KEY = process.env.DEEPSEEK_API_KEY ?? 'apikey-bf6a86a126a846ca81b869b398513c19'

const child = spawn(process.execPath, ['lib/bin.js', '--config', 'cordis.yml'], {
  cwd: process.cwd(),
  env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
let nextId = 1

const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

function send(method, params) {
  const id = nextId++
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  child.stdin.write(payload + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) }
    }, 60000)
  })
}

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()))

try {
  // 1. initialize
  const init = await send('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'smoke-test', version: '1.0' },
  })
  console.log('=== initialize OK ===')
  console.log(JSON.stringify(init.agentCapabilities))

  // 2. newSession
  const sess = await send('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  })
  console.log('=== session/new OK ===', JSON.stringify(sess))

  // 3. prompt (真推理)
  console.log('=== prompt (真实推理中...) ===')
  const promptResult = await send('session/prompt', {
    sessionId: sess.sessionId,
    prompt: [{ type: 'text', text: '只回复"OK"两个字母，不要任何其他内容。' }],
  })
  console.log('=== prompt result ===', JSON.stringify(promptResult))

  console.log('\n=== 真推理验证通过：DSH 通过公司网关完成了对话 ===')
} catch (e) {
  console.error('=== 失败 ===', e.message)
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 2000)
}
