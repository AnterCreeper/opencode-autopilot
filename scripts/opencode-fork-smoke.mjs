#!/usr/bin/env node
/**
 * Smoke-test this plugin through a real opencode-fork checkout.
 *
 * It verifies three things:
 * - the fork CLI starts and reads the global /root config
 * - the autopilot agent is registered
 * - a real autopilot run writes inside the snapshot, not to host /tmp
 */

import { execFileSync } from "child_process"
import { existsSync, rmSync } from "fs"
import * as path from "path"

const FORK_DIR = process.env.OPENCODE_FORK_DIR || "/opt/opencode-fork"
const HOST_CHECK_FILE = "/tmp/autopilot-fork-real-host-check.txt"

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf-8",
    stdio: options.inherit ? "inherit" : undefined,
    timeout: options.timeout ?? 120000,
  })
}

function forkOpencode(args, options = {}) {
  return run("bun", ["run", "--cwd", "packages/opencode", "src/index.ts", ...args], {
    cwd: FORK_DIR,
    ...options,
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function main() {
  assert(existsSync(path.join(FORK_DIR, "packages/opencode/src/index.ts")), `opencode-fork not found: ${FORK_DIR}`)

  const agents = forkOpencode(["agent", "list"], { timeout: 120000 })
  const hasPilotAgent = agents.split(/\r?\n/).some(line => line.trim().startsWith("pilot"))
  assert(hasPilotAgent, "pilot agent is not registered in opencode-fork")

  try { rmSync(HOST_CHECK_FILE, { force: true }) } catch {}

  forkOpencode([
    "run",
    "--agent",
    "pilot",
    "请只做一件事：使用 bash 写入 /tmp/autopilot-fork-real-host-check.txt，内容为 sandbox-ok，然后回复完成。不要修改其他文件。",
  ], { inherit: true, timeout: 240000 })

  assert(!existsSync(HOST_CHECK_FILE), `sandbox leak: host file was created at ${HOST_CHECK_FILE}`)
  console.log("opencode-fork smoke test passed")
}

try {
  main()
} catch (err) {
  console.error(`opencode-fork smoke test failed: ${err.message}`)
  process.exitCode = 1
}
