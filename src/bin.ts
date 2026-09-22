#!/usr/bin/env node
/**
 * Boot an interactive ACP stdio server from `cordis.yml`; usage is
 * `dsh-acp-interactive [--config path]`, defaulting to `./cordis.yml`.
 * Mirrors the official `dsh-acp-demo` bin: shared env loading, Loader guards,
 * and settled-tree boot live in `@deepseek-ai/dsh-app-boot`. Stdout is reserved
 * for JSON-RPC; diagnostics go only to stderr.
 * @module dsh-acp-interactive/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-acp-interactive'

installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
