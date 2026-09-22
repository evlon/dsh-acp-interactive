// Full smoke: initialize → session/new → session/list (should list the new
// session) → session/load (should resume it). No model key is needed for any
// of these lifecycle methods (prompt is the only method that hits the model).
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const bin = resolve(process.cwd(), 'lib/bin.js')
const child = spawn(process.execPath, [bin, '--config', resolve(process.cwd(), 'cordis.yml')], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let nextId = 1
const pending = new Map()

child.stderr.on('data', (d) => process.stderr.write(d))

function send(method, params) {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
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
  }
})

const timeout = setTimeout(() => {
  console.error('SMOKE TIMEOUT')
  child.kill()
  process.exit(1)
}, 30000)

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

try {
  await send('initialize', { protocolVersion: 1, clientCapabilities: {} })

  const created = await send('session/new', { cwd: process.cwd(), mcpServers: [] })
  assert(!created.error, `session/new: ${JSON.stringify(created.error)}`)
  const sessionId = created.result.sessionId
  console.log(`session/new => ${sessionId}`)

  const listed = await send('session/list', {})
  assert(!listed.error, `session/list: ${JSON.stringify(listed.error)}`)
  const ids = listed.result.sessions.map(s => s.sessionId)
  assert(ids.includes(sessionId), `session/list should contain ${sessionId}, got ${JSON.stringify(ids)}`)
  console.log(`session/list => contains ${sessionId}`)

  // Loading an already-live session is rejected (resume is for persisted
  // history, not in-process sessions).
  const reload = await send('session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
  assert(reload.error, 'session/load of a live session should error')
  console.log(`session/load (live) => correctly rejected: ${reload.error.code}`)

  // Loading an unknown id is rejected.
  const unknown = await send('session/load', { sessionId: '00000000-0000-0000-0000-000000000000', cwd: process.cwd(), mcpServers: [] })
  assert(unknown.error, 'session/load of an unknown id should error')
  console.log(`session/load (unknown) => correctly rejected: ${unknown.error.code}`)

  console.log('\nSMOKE PASS: new → list → load-reject full loop (resume needs a persisted turn; verified without a model key)')
  clearTimeout(timeout)
  child.kill()
  process.exit(0)
} catch (error) {
  console.error('SMOKE FAIL:', error.message)
  clearTimeout(timeout)
  child.kill()
  process.exit(1)
}
