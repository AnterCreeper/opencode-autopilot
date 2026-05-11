import { mkdirSync, realpathSync } from "fs"
import { execFileSync, spawn } from "child_process"
import * as path from "path"
import { loadConfig, getBwrapFlags } from "./config.js"
import { resolveAllBinaries } from "./resolve.js"

export interface SandboxState {
  active: boolean
  id: string
  snapshotPath: string
  projectDir: string
  bwrapPid: number | null
  isFork: boolean
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class SandboxManager {
  private config = loadConfig()
  private binaries = resolveAllBinaries(this.config)
  private snapshotDir = this.config.snapshotDir
  private readonly BWRAP_READY_TIMEOUT_MS = 2000
  private readonly BWRAP_READY_POLL_MS = 50

  private dev = ""
  private rootSubvol = ""
  private cleanupRegistered = false
  private cleaningUp = false

  private sessions = new Map<string, SandboxState>()
  private currentSessionId = ""
  private currentAgent = ""
  private mountReady = false

  // Store original args per callID so we can restore them in after hook
  private originalArgs = new Map<string, any>()

  private bypassPrefixes: string[]

  constructor() {
    this.bypassPrefixes = this.buildBypassPrefixes()
  }

  private run(
    command: string,
    args: string[],
    options: { encoding?: BufferEncoding; silent?: boolean; timeout?: number } = {},
  ): string {
    const result = execFileSync(command, args, {
      encoding: options.encoding,
      stdio: options.silent ? "ignore" : undefined,
      timeout: options.timeout ?? 30000,
    })
    return typeof result === "string" ? result : ""
  }

  private initBtrfs(): void {
    if (this.dev) return
    if (process.getuid?.() !== 0) {
      throw new Error("Autopilot btrfs snapshot mode requires root (CAP_SYS_ADMIN)")
    }
    this.dev = this.run(this.binaries.findmnt, ["-n", "-o", "SOURCE", "/"], { encoding: "utf-8" }).trim().replace(/\[.*?\]/, "")
    const out = this.run(this.binaries.btrfs, ["subvolume", "show", "/"], { encoding: "utf-8" })
    const m = out.match(/Name:\s+(\S+)/)
    this.rootSubvol = m ? m[1] : this.config.rootSubvol
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return
    this.cleanupRegistered = true
    const cleanup = () => {
      if (this.cleaningUp) return
      this.cleaningUp = true
      this.discardAll()
    }
    process.on("exit", cleanup)
    process.on("SIGTERM", () => { cleanup(); process.exit(128 + 15) })
    process.on("SIGINT", () => { cleanup(); process.exit(128 + 2) })
  }

  saveOriginalArgs(callID: string, args: any): void {
    if (!this.originalArgs.has(callID)) {
      if (this.originalArgs.size >= 1000) {
        const firstKey = this.originalArgs.keys().next().value
        if (firstKey) this.originalArgs.delete(firstKey)
      }
      this.originalArgs.set(callID, JSON.parse(JSON.stringify(args)))
    }
  }

  restoreOriginalArgs(callID: string, args: any): void {
    const orig = this.originalArgs.get(callID)
    if (orig) {
      Object.assign(args, orig)
      this.originalArgs.delete(callID)
    }
  }

  getSessionId() { return this.currentSessionId }
  setSession(sessionID: string) { this.currentSessionId = sessionID }
  getAgent() { return this.currentAgent }
  setAgent(agent: string) { this.currentAgent = agent }

  getState(): Readonly<SandboxState> | undefined {
    return this.sessions.get(this.currentSessionId)
  }

  private active(): boolean {
    const st = this.sessions.get(this.currentSessionId)
    return Boolean(st?.active)
  }

  private ensureTopLevel(): void {
    this.initBtrfs()
    if (this.mountReady) return
    try { this.run(this.binaries.mountpoint, ["-q", this.snapshotDir]) } catch {
      mkdirSync(this.snapshotDir, { recursive: true })
      this.run(this.binaries.mount, ["-t", "btrfs", "-o", "subvolid=5", this.dev, this.snapshotDir])
    }

    // Verify SOURCE matches exactly (not just prefix) to avoid false positives
    // e.g. /dev/sda1 matching /dev/sda via startsWith.
    const actualSource = this.run(this.binaries.findmnt, ["-n", "-o", "SOURCE", this.snapshotDir], { encoding: "utf-8" }).trim().replace(/\[.*?\]/, "")
    if (actualSource !== this.dev) {
      throw new Error(`Btrfs mount verification failed: expected ${this.dev}, got ${actualSource}`)
    }

    // Also verify filesystem type is btrfs
    const actualFs = this.run(this.binaries.findmnt, ["-n", "-o", "FSTYPE", this.snapshotDir], { encoding: "utf-8" }).trim()
    if (actualFs !== "btrfs") {
      throw new Error(`Btrfs mount verification failed: expected fstype btrfs, got ${actualFs}`)
    }

    this.mountReady = true
    this.registerCleanup()
  }

  private safePath(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid sandbox ID: ${id}`)
    return id
  }

  private getBwrapFlags(): string[] {
    return getBwrapFlags(this.config.bwrapFlags)
  }

  private usesPidNamespace(flags: string[]): boolean {
    return flags.includes("--unshare-pid") || flags.includes("--unshare-all")
  }

  private buildBwrapArgs(st: SandboxState): string[] {
    const flags = this.getBwrapFlags()
    const bindArgs: string[] = []
    for (const p of this.bypassPrefixes) {
      bindArgs.push("--bind", p, p)
    }
    const args = ["--bind", st.snapshotPath, "/", ...bindArgs, ...flags]
    // bwrap 0.11+ with --unshare-pid may need explicit --proc to mount new procfs
    if (this.usesPidNamespace(flags) && !flags.includes("--proc")) {
      args.push("--proc", "/proc")
    }
    if (!flags.some((f) => f.startsWith("--dev"))) {
      args.push("--dev", "/dev")
    }
    args.push(this.binaries.bash, "-c", "while true; do sleep 3600; done")
    return args
  }

  private findBwrapChildPid(parentPid: number): number | undefined {
    const out = this.run(this.binaries.ps, ["--ppid", String(parentPid), "-o", "pid", "--no-headers"], {
      encoding: "utf-8",
      timeout: 5000,
    })
    const pids = out.trim().split("\n").map((s) => parseInt(s.trim(), 10)).filter(Boolean)
    if (pids.length > 0) return pids[pids.length - 1]
    return undefined
  }

  private isPidAlive(pid: number | null): boolean {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private formatBwrapError(st: SandboxState, parentPid: number | undefined, args: string[], cause: string): Error {
    return new Error(
      [
        "AUTOPILOT SANDBOX FAILED: bwrap namespace holder is not available.",
        `Cause: ${cause}`,
        `Session: ${st.id}`,
        `Snapshot: ${st.snapshotPath}`,
        `bwrap parent pid: ${parentPid ?? "unknown"}`,
        `bwrap flags: ${this.getBwrapFlags().join(" ") || "(none)"}`,
        `bwrap args: ${args.join(" ")}`,
        "Refusing to run tools outside the sandbox.",
      ].join("\n"),
    )
  }

  private spawnBwrap(st: SandboxState): void {
    const args = this.buildBwrapArgs(st)
    const child = spawn(this.binaries.bwrap, args, { stdio: "ignore", detached: true })
    let spawnError = ""
    child.on("error", (err) => {
      spawnError = err.message
    })
    child.unref()
    const parentPid = child.pid
    if (!parentPid) {
      throw this.formatBwrapError(st, parentPid, args, "failed to start bwrap process")
    }
    const deadline = Date.now() + this.BWRAP_READY_TIMEOUT_MS
    let lastError = ""

    while (Date.now() < deadline) {
      try {
        if (!this.isPidAlive(parentPid)) {
          lastError = "bwrap parent exited before creating namespace holder"
          break
        }
        const childPid = this.findBwrapChildPid(parentPid)
        if (childPid && this.isPidAlive(childPid)) {
          st.bwrapPid = childPid
          return
        }
      } catch (err: any) {
        lastError = err?.message || String(err)
      }
      if (spawnError) {
        lastError = spawnError
        break
      }
      sleepMs(this.BWRAP_READY_POLL_MS)
    }

    st.bwrapPid = null
    throw this.formatBwrapError(st, parentPid, args, lastError || "timed out waiting for namespace holder")
  }

  private killBwrap(st: SandboxState): void {
    if (st.bwrapPid) {
      try { process.kill(st.bwrapPid, "SIGTERM") } catch {}
      st.bwrapPid = null
    }
  }

  create(projectDir?: string, parentSessionId?: string): SandboxState {
    const existing = this.sessions.get(this.currentSessionId)
    // Active → idempotent
    if (existing?.active) return existing
    // Review → re-activate same snapshot, but respawn bwrap if needed
    if (existing) {
      existing.active = true
      try {
        this.ensureSandboxHealthy(existing)
      } catch (err) {
        existing.active = false
        throw err
      }
      return existing
    }

    const isFork = parentSessionId !== undefined

    this.ensureTopLevel()

    const id = this.safePath(this.currentSessionId)
    const snapshotPath = path.join(this.snapshotDir, `@ap-${id}`)
    const resolvedProject = projectDir || process.cwd()

    // If process restarted but snapshot still on disk, reuse it
    if (this.dirExists(snapshotPath)) {
      const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject, bwrapPid: null, isFork }
      this.sessions.set(this.currentSessionId, st)
      try {
        this.spawnBwrap(st)
      } catch (err) {
        this.sessions.delete(this.currentSessionId)
        throw err
      }
      return st
    }

    let src: string
    if (parentSessionId) {
      const parentState = this.sessions.get(parentSessionId)
      if (parentState?.snapshotPath) {
        src = parentState.snapshotPath
      } else {
        src = path.join(this.snapshotDir, this.rootSubvol)
      }
    } else {
      src = path.join(this.snapshotDir, this.rootSubvol)
    }

    if (!this.dirExists(src)) throw new Error(`Btrfs source not found: ${src}`)

    this.run(this.binaries.btrfs, ["subvolume", "snapshot", src, snapshotPath])

    const st: SandboxState = { active: true, id, snapshotPath, projectDir: resolvedProject, bwrapPid: null, isFork }
    this.sessions.set(this.currentSessionId, st)
    try {
      this.spawnBwrap(st)
    } catch (err) {
      this.sessions.delete(this.currentSessionId)
      throw err
    }
    return st
  }

  deactivate(): void {
    const st = this.sessions.get(this.currentSessionId)
    if (st) st.active = false
  }

  discard(): void {
    const st = this.sessions.get(this.currentSessionId)
    if (!st) return
    this.discardSession(st)
  }

  discardSession(st: SandboxState): void {
    this.killBwrap(st)
    for (const [sid, s] of this.sessions) {
      if (s === st) { this.sessions.delete(sid); break }
    }
  }

  listSnapshots(): Array<{ id: string; snapshotPath: string; active: boolean }> {
    return Array.from(this.sessions.values()).map((st) => ({
      id: st.id,
      snapshotPath: st.snapshotPath,
      active: st.active,
    }))
  }

  discardAll(): void {
    for (const st of this.sessions.values()) {
      this.killBwrap(st)
    }
    this.sessions.clear()
  }

  ensureSandboxHealthy(st: SandboxState): void {
    if (!st.active) return
    if (this.isPidAlive(st.bwrapPid)) return
    st.bwrapPid = null
    this.spawnBwrap(st)
  }

  private detectDnsBypassPrefixes(): string[] {
    const prefixes: string[] = []
    try {
      const resolved = realpathSync("/etc/resolv.conf")
      if (resolved) prefixes.push(resolved)
    } catch {
      // /etc/resolv.conf may not exist or not be readable
    }
    return prefixes
  }

  private buildBypassPrefixes(): string[] {
    const base = [...this.config.bypassPrefixes]
    for (const p of this.detectDnsBypassPrefixes()) {
      if (!base.includes(p)) base.push(p)
    }
    return base
  }

  setBypassPrefixes(prefixes: string[]): void {
    this.bypassPrefixes = [...prefixes]
  }

  private isBypassed(original: string): boolean {
    return this.bypassPrefixes.some((p) => original.startsWith(p))
  }

  private resolveProjectPath(original: string, projectDir: string): string {
    if (!original.startsWith("/")) {
      return path.resolve(projectDir, original)
    }
    return original
  }

  private checkTraversal(resolved: string, snapshotPath: string, original: string): void {
    if (!resolved.startsWith(snapshotPath + "/") && resolved !== snapshotPath) {
      throw new Error(`Path traversal blocked: ${original}`)
    }
  }

  private checkSymlinkEscape(resolved: string, snapshotPath: string, original: string): void {
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

  toSandboxPath(original: string): string {
    if (!this.active()) return original
    if (this.isBypassed(original)) return original
    const st = this.sessions.get(this.currentSessionId)!

    const resolvedOriginal = this.resolveProjectPath(original, st.projectDir)
    const raw = path.join(st.snapshotPath, resolvedOriginal.slice(1))
    const resolved = path.resolve(raw)

    this.checkTraversal(resolved, st.snapshotPath, original)
    this.checkSymlinkEscape(resolved, st.snapshotPath, original)

    return resolved
  }

  wrapNsenterCommand(st: SandboxState, command: string, workdir?: string): string {
    this.ensureSandboxHealthy(st)

    const script = workdir
      ? `cd ${JSON.stringify(workdir)}\n${command}`
      : `cd ${JSON.stringify(st.projectDir)}\n${command}`
    const encoded = Buffer.from(script).toString("base64")
    const flags = this.getBwrapFlags()
    const nsFlags = ["-t", String(st.bwrapPid), "-m"]
    if (this.usesPidNamespace(flags)) {
      nsFlags.push("-p")
    }
    const nsFlagsStr = nsFlags.join(" ")
    return `printf '%s' '${encoded}' | ${this.binaries.base64} -d | ${this.binaries.nsenter} ${nsFlagsStr} ${this.binaries.bash} -s`
  }

  private dirExists(p: string): boolean {
    try { this.run(this.binaries.test, ["-d", p], { silent: true, timeout: 10000 }); return true } catch { return false }
  }

  /**
   * Strip snapshot path prefix from output strings.
   * Agent sees logical paths, not implementation details.
   * Set AUTOPILOT_DEBUG=1 to disable path masking (debug raw paths).
   */
  maskPaths(st: SandboxState, text: string): string {
    if (!text || this.config.debug) return text
    const esc = st.snapshotPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return text.replace(new RegExp(esc + "/", "g"), "/").replace(new RegExp(esc, "g"), "")
  }
}
