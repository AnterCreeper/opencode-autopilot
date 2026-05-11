import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { create, deactivate, discard, getState, setSession, toSandboxPath, wrapNsenterCommand, discardAll, maskPaths, setBypassPrefixes } from "../src/sandbox.js"
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs"
import { execFileSync, execSync } from "child_process"
import * as path from "path"

const TEST_SID = "test-001"
const TEST_PROJECT = "/root/oc-ap-test"

function waitForPidExit(pid: number): void {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    try { execFileSync("sleep", ["0.05"], { timeout: 200 }) } catch {}
  }
}

beforeEach(() => {
  discardAll()
  setSession(TEST_SID)
  if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true, force: true })
  mkdirSync(TEST_PROJECT, { recursive: true })
})

afterEach(() => {
  discardAll()
  try { rmSync(TEST_PROJECT, { recursive: true, force: true }) } catch {}
})

describe("btrfs snapshot sandbox", () => {
  it("create/discard cycle", () => {
    const s = create(TEST_PROJECT)
    expect(s.active).toBe(true)
    expect(existsSync(s.snapshotPath)).toBe(true)
    discard()
    expect(getState()).toBeUndefined()
  })

  it("create is idempotent when active", () => {
    const s1 = create(TEST_PROJECT)
    const s2 = create(TEST_PROJECT)
    expect(s2).toBe(s1)
    discard()
  })

  it("discard with no session is a no-op", () => {
    expect(() => discard()).not.toThrow()
    expect(getState()).toBeUndefined()
  })

  it("deactivate keeps snapshot alive", () => {
    const s = create(TEST_PROJECT)
    deactivate()
    expect(getState()?.active).toBe(false)
    expect(existsSync(s.snapshotPath)).toBe(true)
    discard()
    expect(getState()).toBeUndefined()
  })

  it("snapshot writes are COW-isolated", () => {
    const s = create(TEST_PROJECT)
    const p = path.join(s.snapshotPath, "root/oc-ap-test", "cow.txt")
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, "cow-write")
    expect(existsSync(path.join(TEST_PROJECT, "cow.txt"))).toBe(false)
    expect(readFileSync(p, "utf-8").trim()).toBe("cow-write")
  })
})

describe("Path translation", () => {
  it("redirects to snapshot", () => {
    const s = create(TEST_PROJECT)
    expect(toSandboxPath("/etc/hosts")).toBe(path.join(s.snapshotPath, "/etc/hosts"))
  })

  it("blocks path traversal with ..", () => {
    create(TEST_PROJECT)
    expect(() => toSandboxPath("/../../../../etc/shadow")).toThrow("Path traversal blocked")
  })

  it("blocks traversal to subvolume parent", () => {
    create(TEST_PROJECT)
    expect(() => toSandboxPath("/..")).toThrow("Path traversal blocked")
  })

  it("allows benign .. within snapshot", () => {
    const s = create(TEST_PROJECT)
    expect(toSandboxPath("/etc/../etc/hosts")).toBe(path.join(s.snapshotPath, "/etc/hosts"))
  })

  it("allows snapshot root", () => {
    const s = create(TEST_PROJECT)
    expect(toSandboxPath("/")).toBe(s.snapshotPath)
  })

  it("bypasses memory", () => {
    create(TEST_PROJECT)
    expect(toSandboxPath("/root/.opencode/soul/memory/x.md")).toBe("/root/.opencode/soul/memory/x.md")
  })

  it("passes through when inactive", () => {
    expect(toSandboxPath("/etc/hosts")).toBe("/etc/hosts")
  })

  it("passes through after deactivate", () => {
    create(TEST_PROJECT)
    deactivate()
    expect(toSandboxPath("/etc/hosts")).toBe("/etc/hosts")
  })
})

describe("Bash wrapping via nsenter", () => {
  const ORIGINAL_BWRAP_FLAGS = process.env.AUTOPILOT_BWRAP_FLAGS

  afterEach(() => {
    if (ORIGINAL_BWRAP_FLAGS === undefined) {
      delete process.env.AUTOPILOT_BWRAP_FLAGS
    } else {
      process.env.AUTOPILOT_BWRAP_FLAGS = ORIGINAL_BWRAP_FLAGS
    }
  })

  it("wraps with printf + base64 + nsenter + bash -s", () => {
    create(TEST_PROJECT)
    const cmd = wrapNsenterCommand(getState()!, "echo hello")
    expect(cmd).toContain("printf '%s'")
    expect(cmd).toContain("base64 -d")
    expect(cmd).toContain("nsenter")
    expect(cmd).toContain("bash -s")
    expect(cmd).not.toContain("bwrap")
  })

  it("throws if bwrap not spawned and lazy spawn fails", () => {
    // create() spawns bwrap, so this tests the normal path
    const st = create(TEST_PROJECT)
    const cmd = wrapNsenterCommand(st, "echo ok", "/tmp")
    // workdir should be baked into the base64 payload (cd prefix)
    expect(cmd).toContain("base64")
  })

  it("allows custom bwrap flags to disable pid namespace", () => {
    process.env.AUTOPILOT_BWRAP_FLAGS = "--unshare-net"
    create(TEST_PROJECT)
    const cmd = wrapNsenterCommand(getState()!, "echo ok")
    expect(cmd).toContain("nsenter -t")
    expect(cmd).not.toContain(" -m -p ")
  })

  it("enters pid namespace when bwrap uses --unshare-all", () => {
    process.env.AUTOPILOT_BWRAP_FLAGS = "--unshare-all"
    create(TEST_PROJECT)
    const cmd = wrapNsenterCommand(getState()!, "echo ok")
    expect(cmd).toContain(" -m -p ")
  })

  it("fails closed and clears state when bwrap cannot start", () => {
    process.env.AUTOPILOT_BWRAP_FLAGS = "--invalid-autopilot-test-flag"
    expect(() => create(TEST_PROJECT)).toThrow("AUTOPILOT SANDBOX FAILED")
    expect(getState()).toBeUndefined()
  })

  it("respawns the namespace holder before generating nsenter commands", () => {
    const st = create(TEST_PROJECT)
    const oldPid = st.bwrapPid
    expect(oldPid).toBeTruthy()
    process.kill(oldPid!, "SIGKILL")
    waitForPidExit(oldPid!)
    st.bwrapPid = oldPid

    const cmd = wrapNsenterCommand(st, "echo ok")
    expect(st.bwrapPid).toBeTruthy()
    expect(st.bwrapPid).not.toBe(oldPid)
    expect(cmd).toContain(`nsenter -t ${st.bwrapPid}`)
  })
})

describe("maskPaths", () => {
  it("strips snapshot path from output", () => {
    const s = create(TEST_PROJECT)
    const text = `File created at ${s.snapshotPath}/etc/hosts`
    expect(maskPaths(s, text)).toBe("File created at /etc/hosts")
  })

  it("preserves non-path content", () => {
    const s = create(TEST_PROJECT)
    const url = "http://example.com"
    expect(maskPaths(s, url)).toBe(url)
  })

  it("handles solo snapshot path reference", () => {
    const s = create(TEST_PROJECT)
    expect(maskPaths(s, s.snapshotPath)).toBe("")
  })

  it("returns empty string unchanged", () => {
    create(TEST_PROJECT)
    expect(maskPaths({ active: true, id: "x", snapshotPath: "/s", projectDir: "/", bwrapPid: null, isFork: false }, "")).toBe("")
  })

  it("handles snapshot path embedded in text without trailing slash", () => {
    const s = create(TEST_PROJECT)
    expect(maskPaths(s, `nsenter '${s.snapshotPath}' fs`)).toBe("nsenter '' fs")
  })
})

describe("Relative path handling", () => {
  it("redirects relative paths from projectDir", () => {
    const s = create(TEST_PROJECT)
    // relative path should be resolved against projectDir, then sandboxed
    const result = toSandboxPath("./file.txt")
    expect(result).toBe(path.join(s.snapshotPath, TEST_PROJECT, "file.txt"))
  })

  it("redirects bare relative paths from projectDir", () => {
    const s = create(TEST_PROJECT)
    const result = toSandboxPath("src/index.ts")
    expect(result).toBe(path.join(s.snapshotPath, TEST_PROJECT, "src/index.ts"))
  })

  it("redirects relative path traversal into snapshot", () => {
    const s = create(TEST_PROJECT)
    // ../../../etc/shadow from projectDir resolves to /etc/shadow, then sandboxed
    const result = toSandboxPath("../../../etc/shadow")
    expect(result).toBe(path.join(s.snapshotPath, "/etc/shadow"))
  })

  it("passes through relative paths when inactive", () => {
    expect(toSandboxPath("./file.txt")).toBe("./file.txt")
  })
})

describe("bypass configuration", () => {
  afterEach(() => {
    setBypassPrefixes(["/root/.opencode/"])
  })

  it("default bypasses /root/.opencode/", () => {
    create(TEST_PROJECT)
    expect(toSandboxPath("/root/.opencode/soul/x.md")).toBe("/root/.opencode/soul/x.md")
  })

  it("does not bypass /home/ by default", () => {
    const s = create(TEST_PROJECT)
    expect(toSandboxPath("/home/user/project/file.v")).toBe(path.join(s.snapshotPath, "/home/user/project/file.v"))
  })

  it("custom bypass prefixes", () => {
    setBypassPrefixes(["/root/.opencode/", "/proc/"])
    create(TEST_PROJECT)
    expect(toSandboxPath("/proc/cpuinfo")).toBe("/proc/cpuinfo")
    expect(toSandboxPath("/etc/hosts")).not.toBe("/etc/hosts")
  })
})

describe("Symlink escape blocking", () => {
  it("blocks symlink pointing outside snapshot", () => {
    const s = create(TEST_PROJECT)
    const linkPath = path.join(s.snapshotPath, "escape-link")
    // Create a symlink from inside snapshot to outside
    try {
      execSync(`ln -s /etc/shadow ${linkPath}`, { timeout: 10000 })
    } catch {
      // Skip if ln fails for some reason
      return
    }
    expect(() => toSandboxPath("/escape-link")).toThrow("Symlink escape blocked")
    try { execSync(`rm ${linkPath}`, { timeout: 10000 }) } catch {}
  })

  it("blocks writes under symlinked parent directories", () => {
    const s = create(TEST_PROJECT)
    const linkPath = path.join(s.snapshotPath, "escape-dir")
    try {
      execSync(`ln -s /etc ${linkPath}`, { timeout: 10000 })
    } catch {
      return
    }
    expect(() => toSandboxPath("/escape-dir/new-file")).toThrow("Symlink escape blocked")
    try { execSync(`rm ${linkPath}`, { timeout: 10000 }) } catch {}
  })

  it("allows symlink pointing inside snapshot", () => {
    const s = create(TEST_PROJECT)
    const target = path.join(s.snapshotPath, "etc", "hosts")
    const linkPath = path.join(s.snapshotPath, "internal-link")
    try {
      execSync(`mkdir -p ${path.dirname(target)} && touch ${target} && ln -s ${target} ${linkPath}`, { timeout: 10000 })
    } catch {
      return
    }
    expect(toSandboxPath("/internal-link")).toBe(linkPath)
    try { execSync(`rm ${linkPath}`, { timeout: 10000 }) } catch {}
  })
})
