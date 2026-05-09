import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import AutopilotPlugin from "../src/index.js"
import { discardAll, setSession, getState } from "../src/sandbox.js"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import * as path from "path"

const TEST_PROJECT = "/tmp/oc-ap-index-test"

beforeEach(() => {
  discardAll()
  if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true, force: true })
  mkdirSync(TEST_PROJECT, { recursive: true })
})

afterEach(() => {
  discardAll()
  try { rmSync(TEST_PROJECT, { recursive: true, force: true }) } catch {}
})

describe("index.ts — plugin initialization", () => {
  it("exports a plugin function", () => {
    expect(typeof AutopilotPlugin).toBe("function")
  })

  it("returns hooks object", async () => {
    const plugin = await AutopilotPlugin({ client: {} as any })
    expect(plugin).toHaveProperty("chat.message")
    expect(plugin).toHaveProperty("tool.execute.before")
    expect(plugin).toHaveProperty("tool.execute.after")
    expect(plugin).toHaveProperty("shell.env")
    expect(plugin).toHaveProperty("experimental.chat.system.transform")
    expect(plugin).toHaveProperty("experimental.compaction.autocontinue")
  })
})

describe("index.ts — chat.message autopilot activation", () => {
  it("creates sandbox when switching to autopilot", async () => {
    const plugin = await AutopilotPlugin({ client: {} as any })
    const msg = { sessionID: "idx-ses-01", agent: "autopilot", variant: undefined }
    await (plugin as any)["chat.message"](msg, {})
    const st = getState()
    expect(st?.active).toBe(true)
    expect(existsSync(st!.snapshotPath)).toBe(true)
  })

  it("deactivates when switching away from autopilot", async () => {
    const plugin = await AutopilotPlugin({ client: {} as any })
    const msg1 = { sessionID: "idx-ses-02", agent: "autopilot", variant: undefined }
    await (plugin as any)["chat.message"](msg1, {})
    expect(getState()?.active).toBe(true)

    const msg2 = { sessionID: "idx-ses-02", agent: "build", variant: undefined }
    await (plugin as any)["chat.message"](msg2, {})
    expect(getState()?.active).toBe(false)
  })
})

describe("index.ts — fork inheritance", () => {
  it("detects fork and passes parent session ID", async () => {
    const mockClient = {
      session: {
        get: vi.fn().mockResolvedValue({ data: { parentID: "idx-parent-01" } }),
      },
    }
    const plugin = await AutopilotPlugin({ client: mockClient })

    // Parent session
    const parentMsg = { sessionID: "idx-parent-01", agent: "autopilot", variant: undefined }
    await (plugin as any)["chat.message"](parentMsg, {})
    const parentState = getState()
    expect(parentState?.active).toBe(true)

    // Write marker in parent
    const markerPath = path.join(parentState!.snapshotPath, TEST_PROJECT, "fork-check.txt")
    mkdirSync(path.dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, "parent-data")

    // Child session (fork)
    setSession("idx-child-01")
    const childMsg = { sessionID: "idx-child-01", agent: "autopilot", variant: "fork" }
    await (plugin as any)["chat.message"](childMsg, {})

    // Verify mock was called
    expect(mockClient.session.get).toHaveBeenCalledWith({ path: { id: "idx-child-01" } })

    // Verify child inherited parent's data
    const childState = getState()
    expect(childState?.active).toBe(true)
    expect(existsSync(path.join(childState!.snapshotPath, TEST_PROJECT, "fork-check.txt"))).toBe(true)
  })

  it("falls back to root when fork detection fails", async () => {
    const mockClient = {
      session: {
        get: vi.fn().mockRejectedValue(new Error("session not found")),
      },
    }
    const plugin = await AutopilotPlugin({ client: mockClient })
    const msg = { sessionID: "idx-fork-fail", agent: "autopilot", variant: "fork" }
    await (plugin as any)["chat.message"](msg, {})
    const st = getState()
    expect(st?.active).toBe(true)
    expect(existsSync(st!.snapshotPath)).toBe(true)
  })
})

describe("index.ts — compaction.autocontinue", () => {
  it("enables autocontinue when autopilot is active", async () => {
    const plugin = await AutopilotPlugin({ client: {} as any })
    const msg = { sessionID: "idx-compact-01", agent: "autopilot", variant: undefined }
    await (plugin as any)["chat.message"](msg, {})

    const output = { enabled: false }
    await (plugin as any)["experimental.compaction.autocontinue"]({}, output)
    expect(output.enabled).toBe(true)
  })

  it("does not enable when inactive", async () => {
    const plugin = await AutopilotPlugin({ client: {} as any })
    const output = { enabled: false }
    await (plugin as any)["experimental.compaction.autocontinue"]({}, output)
    expect(output.enabled).toBe(false)
  })
})
