import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { create, discardAll, setSession, wrapNsenterCommand, getState, saveOriginalArgs, restoreOriginalArgs } from "../src/sandbox.js"
import { mkdtempSync, rmSync } from "fs"
import * as path from "path"
import * as os from "os"

let TEST_SID = ""
let TEST_PROJECT = ""

function makeSid(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

beforeEach(() => {
  discardAll()
  TEST_SID = makeSid()
  setSession(TEST_SID)
  TEST_PROJECT = mkdtempSync(path.join(os.tmpdir(), "oc-ap-e2e-"))
})

afterEach(() => {
  discardAll()
  try { rmSync(TEST_PROJECT, { recursive: true, force: true }) } catch {}
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
