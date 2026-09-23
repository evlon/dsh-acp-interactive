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
import { boot, installFailLoud, loadEnv, loadOverlayPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-acp-interactive'

installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    patch: { type: 'string', short: 'p' },
  },
  strict: true,
})
// Resolve the config path: `--config`/`-c` CLI arg wins, then the `DSH_ACP_CONFIG`
// env var (lets hosts inject the config path without passing args), then the
// local default. This keeps HiCoding-style process spawns (`command` + optional
// single-token args) working without relying on multi-token argument splitting.
const configPath = values.config ?? process.env['DSH_ACP_CONFIG'] ?? './cordis.yml'
// Optional overlay patch list: `--patch`/`-p` CLI arg wins, then the
// `DSH_ACP_PATCH` env var (lets hosts such as HiCoding inject a generated
// override — model/MCP/skill overrides — without passing args), mirroring the
// `config` resolution contract. A missing file throws (the host named it); an
// unset value means "no overlay". This is the base+override seam that lets a
// host override the self-contained `cordis.yml` without editing it in place.
const patchPath = values.patch ?? process.env['DSH_ACP_PATCH']
const patches = patchPath === undefined ? undefined : loadOverlayPatches(NAME, patchPath)
const ctx = await boot(NAME, resolveConfigPath(configPath, snapshotMode), patches)
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
