import { mkdirSync, realpathSync } from "fs"
import { execFileSync, spawn } from "child_process"
import * as path from "path"

const snapshotDir = validateDir(process.env.AUTOPILOT_SNAPSHOT_DIR || "/dev/shm/oc-btrfs")

let dev: string
let rootSubvol: string
let cleanupRegistered = false
let cleaningUp = false

function validateDir(dir: string): string {
  if (!path.isAbsolute(dir) || dir.includes("\0")) {
    throw new Error(`Invalid AUTOPILOT_SNAPSHOT_DIR: ${dir}`)
  }
  return path.resolve(dir)
}

function run(command: string, args: string[], options: { encoding?: BufferEncoding; silent?: boolean; timeout?: number } = {}): string {
  const result = execFileSync(command, args, {
    encoding: options.encoding,
    stdio: options.silent ? "ignore" : undefined,
    timeout: options.timeout ?? 30000,
  })
  return typeof result === "string" ? result : ""
}

function initBtrfs(): void {
  if (dev) return
  if (process.getuid?.() !== 0) {
    throw new Error("Autopilot btrfs snapshot mode requires root (CAP_SYS_ADMIN)")
  }
  dev = run("findmnt", ["-n", "-o", "SOURCE", "/"], { encoding: "utf-8" }).trim().replace(/\[.*?\]/, "")
  const out = run("btrfs", ["subvolume", "show", "/"], { encoding: "utf-8" })
  const m = out.match(/Name:\s+(\S+)/)
  rootSubvol = m ? m[1] : "@rootfs"
}

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const cleanup = () => {
    if (cleaningUp) return
    cleaningUp = true
    discardAll()
  }
  process.on("exit", cleanup)
  process.on("SIGTERM", () => { cleanup(); process.exit(128 + 15) })
  process.on("SIGINT", () => { cleanup(); process.exit(128 + 2) })
}

export interface SandboxState {
  active: boolean
  id: string
  snapshotPath: string
  projectDir: string
  bwrapPid: number | null
  isFork: boolean
}

const sessions = new Map<string, SandboxState>()
let currentSessionId = ""
let currentAgent = ""
let mountReady = false

// Store original args per callID so we can restore them in after hook
const originalArgs = new Map<string, any>()

export function saveOriginalArgs(callID: string, args: any): void {
  if (!originalArgs.has(callID)) {
    if (originalArgs.size >= 1000) {
      const firstKey = originalArgs.keys().next().value
      if (firstKey) originalArgs.delete(firstKey)
    }
    originalArgs.set(callID, JSON.parse(JSON.stringify(args)))
  }
}

export function restoreOriginalArgs(callID: string, args: any): void {
  const orig = originalArgs.get(callID)
  if (orig) {
    Object.assign(args, orig)
    originalArgs.delete(callID)
  }
}

export function getSessionId() { return currentSessionId }
export function setSession(sessionID: string) { currentSessionId = sessionID }
export function getAgent() { return currentAgent }
export function setAgent(agent: string) { currentAgent = agent }

export function getState(): Readonly<SandboxState> | undefined {
  return sessions.get(currentSessionId)
}

function active(): boolean {
  const st = sessions.get(currentSessionId)
  return Boolean(st?.active)
}

function ensureTopLevel(): void {
  initBtrfs()
  if (mountReady) return
  try { run("mountpoint", ["-q", snapshotDir]) } catch {
    mkdirSync(snapshotDir, { recursive: true })
    run("mount", ["-t", "btrfs", "-o", "subvolid=5", dev, snapshotDir])
  }
  const actual = run("findmnt", ["-n", "-o", "SOURCE", snapshotDir], { encoding: "utf-8" }).trim()
  if (!actual.startsWith(dev)) {
    throw new Error(`Btrfs mount verification failed: expected ${dev}, got ${actual}`)
  }
  mountReady = true
  registerCleanup()
}

function safePath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid sandbox ID: ${id}`)
  return id
}

function buildBwrapArgs(st: SandboxState): string[] {
  const flags = (process.env.AUTOPILOT_BWRAP_FLAGS ?? "--unshare-pid").split(" ").filter(Boolean)
  const bindArgs: string[] = []
  for (const p of bypassPrefixes) {
    bindArgs.push("--bind", p, p)
  }
  const args = ["--bind", st.snapshotPath, "/", ...bindArgs, ...flags]
  // bwrap 0.11+ with --unshare-pid may need explicit --proc to mount new procfs
  if (flags.includes("--unshare-pid") && !flags.includes("--proc")) {
    args.push("--proc", "/proc")
  }
  if (!flags.some(f => f.startsWith("--dev"))) {
    args.push("--dev", "/dev")
  }
  args.push("/bin/bash", "-c", "while true; do sleep 3600; done")
  return args
}

function findBwrapChildPid(parentPid: number): number {
  const out = run("ps", ["--ppid", String(parentPid), "-o", "pid", "--no-headers"], {
    encoding: "utf-8",
    timeout: 5000,
  })
  const pids = out.trim().split("\n").map(s => parseInt(s.trim(), 10)).filter(Boolean)
  if (pids.length > 0) return pids[pids.length - 1]
  throw new Error("bwrap failed to create sandbox namespace — no child process found")
}

function spawnBwrap(st: SandboxState): void {
  const args = buildBwrapArgs(st)
  const child = spawn("/usr/bin/bwrap", args, { stdio: "ignore", detached: true })
  child.unref()
  // Give bwrap time to clone into new namespace
  try { execFileSync("sleep", ["0.1"], { timeout: 500 }) } catch {}
  // bwrap parent just waits; the child holds the actual sandbox namespace
  st.bwrapPid = findBwrapChildPid(child.pid!)
}

function killBwrap(st: SandboxState): void {
  if (st.bwrapPid) {
    try { process.kill(st.bwrapPid, "SIGTERM") } catch {}
    st.bwrapPid = null
  }
}

export function create(projectDir?: string, parentSessionId?: string): SandboxState {
  const existing = sessions.get(currentSessionId)
  // Active → idempotent
  if (existing?.active) return existing
  // Review → re-activate same snapshot, but respawn bwrap if needed
  if (existing) {
    existing.active = true
    if (existing.bwrapPid === null) {
      spawnBwrap(existing)
    }
    return existing
  }

  const isFork = parentSessionId !== undefined

  ensureTopLevel()

  const id = safePath(currentSessionId)
  const snapshotPath = path.join(snapshotDir, `@ap-${id}`)
  const resolvedProject = projectDir || process.cwd()

  // If process restarted but snapshot still on disk, reuse it
  if (dirExists(snapshotPath)) {
    const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject, bwrapPid: null, isFork }
    sessions.set(currentSessionId, st)
    spawnBwrap(st)
    return st
  }

  let src: string
  if (parentSessionId) {
    const parentState = sessions.get(parentSessionId)
    if (parentState?.snapshotPath) {
      src = parentState.snapshotPath
    } else {
      src = path.join(snapshotDir, rootSubvol)
    }
  } else {
    src = path.join(snapshotDir, rootSubvol)
  }

  if (!dirExists(src)) throw new Error(`Btrfs source not found: ${src}`)

  run("btrfs", ["subvolume", "snapshot", src, snapshotPath])

  const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject, bwrapPid: null, isFork }
  sessions.set(currentSessionId, st)
  spawnBwrap(st)
  return st
}

export function deactivate(): void {
  const st = sessions.get(currentSessionId)
  if (st) st.active = false
}

export function discard(): void {
  const st = sessions.get(currentSessionId)
  if (!st) return
  discardSession(st)
}

export function discardSession(st: SandboxState): void {
  killBwrap(st)
  for (const [sid, s] of sessions) {
    if (s === st) { sessions.delete(sid); break }
  }
}

export function listSnapshots(): Array<{ id: string; snapshotPath: string; active: boolean }> {
  return Array.from(sessions.values()).map(st => ({
    id: st.id,
    snapshotPath: st.snapshotPath,
    active: st.active,
  }))
}

export function discardAll(): void {
  for (const st of sessions.values()) {
    killBwrap(st)
  }
  sessions.clear()
}

let bypassPrefixes: string[] = (() => {
  const env = process.env.AUTOPILOT_BYPASS_PREFIXES
  if (env) return env.split(",").map(p => p.trim()).filter(Boolean)
  return ["/root/.opencode/"]
})()

export function setBypassPrefixes(prefixes: string[]): void {
  bypassPrefixes = [...prefixes]
}

function isBypassed(original: string): boolean {
  return bypassPrefixes.some(p => original.startsWith(p))
}

function resolveProjectPath(original: string, projectDir: string): string {
  if (!original.startsWith("/")) {
    return path.resolve(projectDir, original)
  }
  return original
}

function checkTraversal(resolved: string, snapshotPath: string, original: string): void {
  if (!resolved.startsWith(snapshotPath + "/") && resolved !== snapshotPath) {
    throw new Error(`Path traversal blocked: ${original}`)
  }
}

function checkSymlinkEscape(resolved: string, snapshotPath: string, original: string): void {
  let probe = resolved
  while (true) {
    try {
      const real = realpathSync(probe)
      if (!real.startsWith(snapshotPath + "/") && real !== snapshotPath) {
        throw new Error(`Symlink escape blocked: ${original} → ${real}`)
      }
      return
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err
      const parent = path.dirname(probe)
      if (parent === probe) throw err
      probe = parent
    }
  }
}

export function toSandboxPath(original: string): string {
  if (!active()) return original
  if (isBypassed(original)) return original
  const st = sessions.get(currentSessionId)!

  const resolvedOriginal = resolveProjectPath(original, st.projectDir)
  const raw = path.join(st.snapshotPath, resolvedOriginal.slice(1))
  const resolved = path.resolve(raw)

  checkTraversal(resolved, st.snapshotPath, original)
  checkSymlinkEscape(resolved, st.snapshotPath, original)

  return resolved
}

export function wrapNsenterCommand(st: SandboxState, command: string, workdir?: string): string {
  if (st.bwrapPid === null) {
    spawnBwrap(st)
  }

  const script = workdir
    ? `cd ${JSON.stringify(workdir)}\n${command}`
    : `cd ${JSON.stringify(st.projectDir)}\n${command}`
  const encoded = Buffer.from(script).toString("base64")
  const flags = process.env.AUTOPILOT_BWRAP_FLAGS ?? "--unshare-pid"
  const nsFlags = ["-t", String(st.bwrapPid), "-m"]
  if (flags.includes("--unshare-pid")) {
    nsFlags.push("-p")
  }
  const nsFlagsStr = nsFlags.join(" ")
  return `printf '%s' '${encoded}' | base64 -d | nsenter ${nsFlagsStr} bash -s`
}

function dirExists(p: string): boolean {
  try { run("test", ["-d", p], { silent: true, timeout: 10000 }); return true } catch { return false }
}

const DEBUG_MODE = process.env.AUTOPILOT_DEBUG === "1"

/**
 * Strip snapshot path prefix from output strings.
 * Agent sees logical paths, not implementation details.
 * Set AUTOPILOT_DEBUG=1 to disable path masking (debug raw paths).
 */
export function maskPaths(st: SandboxState, text: string): string {
  if (!text || DEBUG_MODE) return text
  const esc = st.snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(new RegExp(esc + "/", "g"), "/").replace(new RegExp(esc, "g"), "")
}
