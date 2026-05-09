import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { create, discardAll, setSession, wrapBashCommand, saveOriginalArgs, restoreOriginalArgs } from "../src/sandbox.js"

const TEST_SID = "e2e-001"
const TEST_PROJECT = "/tmp/oc-ap-e2e"

beforeEach(() => {
  discardAll()
  setSession(TEST_SID)
})

afterEach(() => {
  discardAll()
})

describe("e2e — wrapBashCommand escaping", () => {
  it("uses printf instead of echo and quotes snapshot path", () => {
    create(TEST_PROJECT)
    const wrapped = wrapBashCommand("echo test")
    expect(wrapped).toContain("printf '%s'")
    expect(wrapped).not.toContain("echo '")
    expect(wrapped).toContain("chroot '")
    expect(wrapped).toContain("' /bin/bash -s")
  })
})

describe("e2e — originalArgs leak prevention", () => {
  it("does not throw when exceeding 1000 entries", () => {
    create(TEST_PROJECT)
    // Fill beyond limit — should silently drop oldest
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
