// Minimal smoke driver: boots the built bin over stdio, sends an ACP
// `initialize` then `session/list`, and asserts both get valid JSON-RPC
// responses. No model key is needed for these two methods.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const bin = resolve(process.cwd(), 'lib/bin.js')
const child = spawn(process.execPath, [bin, '--config', resolve(process.cwd(), 'cordis.yml')], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const responses = []
let nextId = 1
const pending = new Map()

child.stderr.on('data', (d) => process.stderr.write(d))

function send(method, params) {
  const id = nextId++
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  child.stdin.write(msg + '\n')
  return new Promise((res) => pending.set(id, res))
}

child.stdout.on('data', (d) => {
  buffer += d.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      pending.get(parsed.id)(parsed)
      pending.delete(parsed.id)
    }
    responses.push(parsed)
  }
})

const timeout = setTimeout(() => {
  console.error('SMOKE TIMEOUT — responses so far:', JSON.stringify(responses, null, 2))
  child.kill()
  process.exit(1)
}, 30000)

try {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  })
  console.log('=== initialize ===')
  console.log(JSON.stringify(init, null, 2))
  if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`)
  if (!init.result?.agentCapabilities?.loadSession) {
    throw new Error('FAIL: interactive agent did not advertise loadSession')
  }

  const list = await send('session/list', {})
  console.log('=== session/list ===')
  console.log(JSON.stringify(list, null, 2))
  if (list.error) throw new Error(`session/list error: ${JSON.stringify(list.error)}`)
  if (!Array.isArray(list.result?.sessions)) {
    throw new Error('FAIL: session/list did not return a sessions array')
  }

  console.log('\nSMOKE PASS: initialize + session/list both responded correctly')
  clearTimeout(timeout)
  child.kill()
  process.exit(0)
} catch (error) {
  console.error('SMOKE FAIL:', error.message)
  clearTimeout(timeout)
  child.kill()
  process.exit(1)
}
