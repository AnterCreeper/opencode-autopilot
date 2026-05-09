import { mkdirSync, realpathSync } from "fs"
import { execFileSync } from "child_process"
import * as path from "path"

const TOP_MNT = safeMountPath(process.env.AUTOPILOT_TOP_MNT || "/dev/shm/oc-btrfs")
const BTRFS_SUBVOLID = safeSubvolId(process.env.AUTOPILOT_BTRFS_SUBVOLID || "5")

let dev: string
let rootSubvol: string
let cleanupRegistered = false
let cleaningUp = false

function safeMountPath(mountPath: string): string {
  if (!path.isAbsolute(mountPath) || mountPath.includes("\0")) {
    throw new Error(`Invalid AUTOPILOT_TOP_MNT: ${mountPath}`)
  }
  return path.resolve(mountPath)
}

function safeSubvolId(subvolId: string): number {
  if (!/^\d+$/.test(subvolId)) throw new Error(`Invalid AUTOPILOT_BTRFS_SUBVOLID: ${subvolId}`)
  const parsed = Number(subvolId)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid AUTOPILOT_BTRFS_SUBVOLID: ${subvolId}`)
  }
  return parsed
}

function run(command: string, args: string[], options: { encoding?: BufferEncoding; silent?: boolean; timeout?: number } = {}): string {
  const result = execFileSync(command, args, {
    encoding: options.encoding,
    stdio: options.silent ? "ignore" : undefined,
    timeout: options.timeout ?? 30000,
  })
  return typeof result === "string" ? result : ""
}

function isSnapshotPath(snapshotPath: string): boolean {
  return snapshotPath.startsWith(TOP_MNT + "/@ap-")
}

function deleteSnapshot(snapshotPath: string): void {
  if (!isSnapshotPath(snapshotPath)) {
    throw new Error(`Refusing to delete unexpected snapshot path: ${snapshotPath}`)
  }
  try { run("btrfs", ["subvolume", "delete", snapshotPath], { silent: true }) } catch { /* best effort */ }
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
    if (topMounted) {
      try { run("umount", [TOP_MNT], { silent: true }) } catch { /* best effort */ }
      topMounted = false
    }
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
}

const sessions = new Map<string, SandboxState>()
let currentSessionId = ""
let currentAgent = ""
let topMounted = false

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

function cleanupOrphanSnapshots(): void {
  // Scan for @ap-* snapshots using btrfs subvolume list for precise metadata.
  // This handles leftovers from SIGKILL or process crashes.
  try {
    const output = run("btrfs", ["subvolume", "list", TOP_MNT], { encoding: "utf-8", timeout: 10000 })
    const lines = output.split("\n").filter(Boolean)
    for (const line of lines) {
      const m = line.match(/path\s+(\S+)$/)
      if (!m) continue
      const entry = m[1]
      if (!/^@ap-[a-zA-Z0-9_-]+$/.test(entry)) continue
      const snapPath = path.join(TOP_MNT, entry)
      const tracked = Array.from(sessions.values()).some(s => s.snapshotPath === snapPath)
      if (!tracked) {
        try {
          deleteSnapshot(snapPath)
        } catch {
          // Best effort: may fail if already deleted or not a subvolume
        }
      }
    }
  } catch {
    // Best effort: btrfs list may fail if TOP_MNT not fully ready
  }
}

function ensureTopLevel(): void {
  initBtrfs()
  if (topMounted) return
  try { run("mountpoint", ["-q", TOP_MNT]) } catch {
    mkdirSync(TOP_MNT, { recursive: true })
    run("mount", ["-t", "btrfs", "-o", `subvolid=${BTRFS_SUBVOLID}`, dev, TOP_MNT])
  }
  const actual = run("findmnt", ["-n", "-o", "SOURCE", TOP_MNT], { encoding: "utf-8" }).trim()
  if (!actual.startsWith(dev)) {
    throw new Error(`Btrfs top-level mount verification failed: expected ${dev}, got ${actual}`)
  }
  topMounted = true
  cleanupOrphanSnapshots()
  registerCleanup()
}

function safePath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid sandbox ID: ${id}`)
  return id
}

export function create(projectDir?: string, parentSessionId?: string): SandboxState {
  const existing = sessions.get(currentSessionId)
  // Active → idempotent
  if (existing?.active) return existing
  // Review → re-activate same snapshot
  if (existing) {
    existing.active = true
    return existing
  }

  ensureTopLevel()

  const id = safePath(currentSessionId)
  const snapshotPath = path.join(TOP_MNT, `@ap-${id}`)
  const resolvedProject = projectDir || process.cwd()

  // If process restarted but snapshot still on disk, reuse it
  if (dirExists(snapshotPath)) {
    const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject }
    sessions.set(currentSessionId, st)
    return st
  }

  let src: string
  if (parentSessionId) {
    const parentState = sessions.get(parentSessionId)
    if (parentState?.snapshotPath) {
      src = parentState.snapshotPath
    } else {
      // Parent session not tracked by plugin, fallback to root
      src = path.join(TOP_MNT, rootSubvol)
    }
  } else {
    src = path.join(TOP_MNT, rootSubvol)
  }

  if (!dirExists(src)) throw new Error(`Btrfs source not found: ${src}`)

  run("btrfs", ["subvolume", "snapshot", src, snapshotPath])

  const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject }
  sessions.set(currentSessionId, st)
  return st
}

export function deactivate(): void {
  const st = sessions.get(currentSessionId)
  if (st) st.active = false
}

function tryUnmount(): void {
  if (!topMounted || sessions.size > 0) return
  try { run("umount", [TOP_MNT], { silent: true }) } catch { /* best effort */ }
  topMounted = false
}

export function discard(): void {
  const st = sessions.get(currentSessionId)
  if (!st) return
  discardSession(st)
}

export function discardSession(st: SandboxState): void {
  deleteSnapshot(st.snapshotPath)
  // Delete by reference to avoid key mismatch
  for (const [sid, s] of sessions) {
    if (s === st) { sessions.delete(sid); break }
  }
  tryUnmount()
}

export function listSnapshots(): Array<{ id: string; snapshotPath: string; active: boolean }> {
  return Array.from(sessions.values()).map(st => ({
    id: st.id,
    snapshotPath: st.snapshotPath,
    active: st.active,
  }))
}

export function discardAll(): void {
  for (const [sid, st] of sessions) {
    if (!isSnapshotPath(st.snapshotPath)) continue
    deleteSnapshot(st.snapshotPath)
  }
  sessions.clear()
  tryUnmount()
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

export function wrapBashCommand(command: string): string {
  if (!active()) return command
  const st = sessions.get(currentSessionId)!
  const script = `cd ${JSON.stringify(st.projectDir)}\n${command}`
  const encoded = Buffer.from(script).toString("base64")
  const safeSnapshotPath = st.snapshotPath.replace(/'/g, "'\\''")
  return `printf '%s' '${encoded}' | base64 -d | chroot '${safeSnapshotPath}' /bin/bash -s`
}

function dirExists(p: string): boolean {
  try { run("test", ["-d", p], { silent: true, timeout: 10000 }); return true } catch { return false }
}

const DEBUG_MODE = process.env.AUTOPILOT_DEBUG === "1"

/**
 * Strip snapshot path prefix from output strings.
 * Agent sees logical paths, not implementation details.
 * Set AUTOPILOT_DEBUG=1 to show raw paths.
 */
export function maskPaths(st: SandboxState, text: string): string {
  if (!text || DEBUG_MODE) return text
  const escaped = st.snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(new RegExp(escaped + "/", "g"), "/").replace(new RegExp("^" + escaped + "$"), "")
}
