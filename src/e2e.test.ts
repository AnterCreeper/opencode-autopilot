import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { create, discardAll, setSession, wrapNsenterCommand, getState, saveOriginalArgs, restoreOriginalArgs } from "../src/sandbox.js"

const TEST_SID = "e2e-001"
const TEST_PROJECT = "/tmp/oc-ap-e2e"

beforeEach(() => {
  discardAll()
  setSession(TEST_SID)
})

afterEach(() => {
  discardAll()
})

describe("e2e — wrapNsenterCommand", () => {
  it("generates nsenter pipeline string", () => {
    const st = create(TEST_PROJECT)
    const cmd = wrapNsenterCommand(st, "echo nsenter_works")
    expect(cmd).toContain("nsenter")
    expect(cmd).toContain("base64 -d")
    expect(cmd).toContain("bash -s")
  })
})

describe("e2e — originalArgs leak prevention", () => {
  it("does not throw when exceeding 1000 entries", () => {
    create(TEST_PROJECT)
    for (let i = 0; i < 1005; i++) {
      saveOriginalArgs(`call-${i}`, { cmd: "test" })
    }
    expect(() => saveOriginalArgs("call-overflow", { cmd: "test" })).not.toThrow()
  })

  it("still restores correctly within limit", () => {
    create(TEST_PROJECT)
    const original = { command: "echo hello" }
    saveOriginalArgs("call-ok", original)
    const modified = { command: "echo modified" }
    Object.assign(original, modified)
    restoreOriginalArgs("call-ok", original)
    expect(original.command).toBe("echo hello")
  })
})
