import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { create, discardAll, getState, setSession, setBypassPrefixes } from "../src/sandbox.js"
import { onToolExecuteBefore, onToolExecuteAfter, onShellEnv, onSystemTransform } from "../src/hooks.js"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import * as path from "path"

const TEST_SID = "htest-01"
const TEST_PROJECT = "/tmp/oc-ap-hooks-test"

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

describe("hooks — bash", () => {
  it("wraps inactive", async () => {
    const o = { args: { command: "make" } }
    await onToolExecuteBefore({ tool: "bash", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.command).toBe("make")
  })

  it("wraps with base64 + nsenter + bash -s", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { command: "make all" } }
    await onToolExecuteBefore({ tool: "bash", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.command).toContain("nsenter")
    expect(o.args.command).toContain("base64 -d")
    expect(o.args.command).toContain("bash -s")
    expect(o.args.command).not.toContain("OCAP-")
    expect(o.args.command).not.toContain("<<")
    expect(o.args.command).not.toContain("bwrap")
  })

  it("rewrites the original args object in place", async () => {
    create(TEST_PROJECT)
    const args = { command: "pwd" }
    const o = { args }
    await onToolExecuteBefore({ tool: "bash", sessionID: TEST_SID, callID: "c-inplace" }, o)
    expect(o.args).toBe(args)
    expect(args.command).toContain("nsenter")
  })
})

describe("hooks — filePath tools", () => {
  for (const t of ["write", "edit", "read", "lsp"]) {
    it(`${t} redirects`, async () => {
      const s = create(TEST_PROJECT)
      const o = { args: { filePath: "/etc/hosts" } }
      await onToolExecuteBefore({ tool: t, sessionID: TEST_SID, callID: "c1" }, o)
      expect(o.args.filePath).toBe(path.join(s.snapshotPath, "/etc/hosts"))
    })
  }
})

describe("hooks — glob/grep", () => {
  for (const t of ["glob", "grep"]) {
    it(`${t} redirects`, async () => {
      const s = create(TEST_PROJECT)
      const o = { args: { path: "/tmp" } }
      await onToolExecuteBefore({ tool: t, sessionID: TEST_SID, callID: "c1" }, o)
      expect(o.args.path).toBe(path.join(s.snapshotPath, "/tmp"))
    })
  }
})

describe("hooks — apply_patch", () => {
  it("rewrites paths", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { patchText: "--- /a.v\n+++ /b.v\n" } }
    await onToolExecuteBefore({ tool: "apply_patch", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.patchText).toContain(path.join(s.snapshotPath, "/a.v"))
  })

  it("rewrites apply_patch file headers with relative paths", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { patchText: "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-old\n+new\n*** End Patch" } }
    await onToolExecuteBefore({ tool: "apply_patch", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.patchText).toContain(`*** Update File: ${path.join(s.snapshotPath, TEST_PROJECT, "src/main.ts")}`)
  })

  it("rewrites apply_patch add/delete/move headers", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { patchText: "*** Begin Patch\n*** Add File: a.txt\n*** Delete File: b.txt\n*** Move to: c.txt\n*** End Patch" } }
    await onToolExecuteBefore({ tool: "apply_patch", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.patchText).toContain(`*** Add File: ${path.join(s.snapshotPath, TEST_PROJECT, "a.txt")}`)
    expect(o.args.patchText).toContain(`*** Delete File: ${path.join(s.snapshotPath, TEST_PROJECT, "b.txt")}`)
    expect(o.args.patchText).toContain(`*** Move to: ${path.join(s.snapshotPath, TEST_PROJECT, "c.txt")}`)
  })

  it("handles git-format a/ b/ prefixes", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { patchText: "--- a/main.v\n+++ b/main.v\n@@ -1,3 +1,4 @@\n" } }
    await onToolExecuteBefore({ tool: "apply_patch", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.patchText).toContain("--- a/main.v")
    expect(o.args.patchText).toContain("+++ b/main.v")
  })

  it("redirects git-format absolute paths", async () => {
    const s = create(TEST_PROJECT)
    const o = { args: { patchText: "--- /tmp/git/a.v\n+++ /tmp/git/b.v\n" } }
    await onToolExecuteBefore({ tool: "apply_patch", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.patchText).toContain(`--- ${path.join(s.snapshotPath, "/tmp/git/a.v")}`)
  })
})

describe("hooks — memory bypass", () => {
  it("does not redirect memory paths", async () => {
    create(TEST_PROJECT)
    const o = { args: { filePath: "/root/.opencode/soul/memory/x.md" } }
    await onToolExecuteBefore({ tool: "write", sessionID: TEST_SID, callID: "c1" }, o)
    expect(o.args.filePath).toBe("/root/.opencode/soul/memory/x.md")
  })
})

describe("hooks — passthrough", () => {
  for (const t of ["task", "question", "skill", "todowrite", "webfetch", "websearch"]) {
    it(`passes ${t}`, async () => {
      create(TEST_PROJECT)
      const o = { args: { x: 1 } }
      await onToolExecuteBefore({ tool: t, sessionID: TEST_SID, callID: "c1" }, o)
      expect(o.args.x).toBe(1)
    })
  }
})

describe("shell.env", () => {
  it("injects", async () => {
    const s = create(TEST_PROJECT)
    const o: { env: Record<string, string> } = { env: {} }
    await onShellEnv({ cwd: "/tmp" }, o)
    expect(o.env.AUTOPILOT_ACTIVE).toBe("1")
    expect(o.env.SANDBOX_ROOT).toBe(s.snapshotPath)
  })

  it("sets session from input.sessionID", async () => {
    const s = create(TEST_PROJECT)
    const o: { env: Record<string, string> } = { env: {} }
    await onShellEnv({ cwd: "/tmp", sessionID: TEST_SID }, o)
    expect(o.env.SANDBOX_ROOT).toBe(s.snapshotPath)
  })
})

describe("hooks — after masking", () => {
  it("masks snapshot paths in output", async () => {
    const s = create(TEST_PROJECT)
    const input = { tool: "bash", sessionID: TEST_SID, callID: "c2", args: { command: "echo test" } }
    const output = { title: `File: ${s.snapshotPath}/etc/hosts`, output: `Created at ${s.snapshotPath}/tmp/x`, metadata: {} }
    await onToolExecuteAfter(input, output)
    expect(output.title).toBe("File: /etc/hosts")
    expect(output.output).toBe("Created at /tmp/x")
  })

  it("restores original args after masking", async () => {
    const s = create(TEST_PROJECT)
    const beforeOutput = { args: { command: "echo test" } }
    await onToolExecuteBefore({ tool: "bash", sessionID: TEST_SID, callID: "c3" }, beforeOutput)
    // args were modified by before hook (printf|base64|nsenter)
    expect(beforeOutput.args.command).toContain("nsenter")

    const afterInput = { tool: "bash", sessionID: TEST_SID, callID: "c3", args: { command: beforeOutput.args.command } }
    const afterOutput = { title: "ok", output: "ok", metadata: {} }
    await onToolExecuteAfter(afterInput, afterOutput)
    // args restored to original value
    expect(afterInput.args.command).toBe("echo test")
  })
})

describe("hooks — DEBUG_MODE", () => {
  const ORIGINAL_DEBUG = process.env.AUTOPILOT_DEBUG

  beforeEach(() => {
    process.env.AUTOPILOT_DEBUG = "1"
  })

  afterEach(() => {
    if (ORIGINAL_DEBUG === undefined) {
      delete process.env.AUTOPILOT_DEBUG
    } else {
      process.env.AUTOPILOT_DEBUG = ORIGINAL_DEBUG
    }
  })

  it("prefixes output with debug info when DEBUG_MODE is enabled", async () => {
    create(TEST_PROJECT)
    const input = { tool: "bash", sessionID: TEST_SID, callID: "debug-1", args: { command: "echo test" } }
    const output = { title: "ok", output: "hello", metadata: {} }
    await onToolExecuteAfter(input, output)
    expect(output.output).toContain("[AUTOPILOT DEBUG]")
    expect(output.output).toContain("Raw command:")
  })
})

describe("hooks — system prompt deduplication", () => {
  it("injects only once per state", async () => {
    create(TEST_PROJECT)
    const output1 = { system: [] }
    await onSystemTransform({ sessionID: TEST_SID }, output1)
    expect(output1.system.length).toBe(1)
    expect(output1.system[0]).toContain("AUTOPILOT ACTIVE")
    expect(output1.system[0]).toContain("Do NOT start system services")

    // Second call with same state — should not inject again
    const output2 = { system: [] }
    await onSystemTransform({ sessionID: TEST_SID }, output2)
    expect(output2.system.length).toBe(0)
  })

  it("injects fork-specific warning for forked sessions", async () => {
    const forkSid = "fork-prompt-01"
    setSession(forkSid)
    create(TEST_PROJECT, "some-parent")
    const out = { system: [] }
    await onSystemTransform({ sessionID: forkSid }, out)
    expect(out.system[0]).toContain("FORKED")
    expect(out.system[0]).toContain("previous session")
    discardAll()
  })

  it("re-injects when state changes", async () => {
    const sid2 = "sys-dedup-02"
    setSession(sid2)
    create(TEST_PROJECT)
    const outActive = { system: [] }
    await onSystemTransform({ sessionID: sid2 }, outActive)
    expect(outActive.system[0]).toContain("ACTIVE")

    // Deactivate
    const { deactivate } = await import("../src/sandbox.js")
    deactivate()

    const outReview = { system: [] }
    await onSystemTransform({ sessionID: sid2 }, outReview)
    expect(outReview.system.length).toBe(1)
    expect(outReview.system[0]).toContain("REVIEW")
  })
})

describe("hooks — system prompt LRU eviction", () => {
  const ORIGINAL_MAX = process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE

  beforeEach(() => {
    process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE = "5"
  })

  afterEach(() => {
    if (ORIGINAL_MAX === undefined) {
      delete process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE
    } else {
      process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE = ORIGINAL_MAX
    }
  })

  it("evicts oldest entries when exceeding limit", async () => {
    // Fill beyond small limit — should silently drop oldest
    for (let i = 0; i < 7; i++) {
      const sid = `lru-${i}`
      setSession(sid)
      create(TEST_PROJECT)
      const out = { system: [] }
      await onSystemTransform({ sessionID: sid }, out)
    }
    // Should not throw; oldest entries may have been evicted
    const sidLast = "lru-last"
    setSession(sidLast)
    create(TEST_PROJECT)
    const outLast = { system: [] }
    await expect(onSystemTransform({ sessionID: sidLast }, outLast)).resolves.not.toThrow()
    expect(outLast.system.length).toBe(1)
  })
})

describe("hooks — fork inheritance", () => {
  it("child snapshot inherits from parent", async () => {
    const parentSid = "fork-parent-01"
    const childSid = "fork-child-01"

    // Parent session
    setSession(parentSid)
    const parent = create(TEST_PROJECT)
    expect(parent.active).toBe(true)

    // Write something in parent snapshot
    const markerPath = path.join(parent.snapshotPath, TEST_PROJECT, "fork-marker.txt")
    mkdirSync(path.dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, "parent")

    // Child session inherits from parent
    setSession(childSid)
    const child = create(TEST_PROJECT, parentSid)
    expect(child.active).toBe(true)
    // Child should see parent's file
    expect(existsSync(path.join(child.snapshotPath, TEST_PROJECT, "fork-marker.txt"))).toBe(true)

    // Child's modification should not affect parent
    writeFileSync(path.join(child.snapshotPath, TEST_PROJECT, "child-only.txt"), "child")
    expect(existsSync(path.join(parent.snapshotPath, TEST_PROJECT, "child-only.txt"))).toBe(false)

    discardAll()
  })
})
