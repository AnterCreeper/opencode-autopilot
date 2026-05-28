import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.js"

const ORIGINAL_SNAPSHOT_DIR = process.env.AUTOPILOT_SNAPSHOT_DIR

afterEach(() => {
  if (ORIGINAL_SNAPSHOT_DIR === undefined) {
    delete process.env.AUTOPILOT_SNAPSHOT_DIR
  } else {
    process.env.AUTOPILOT_SNAPSHOT_DIR = ORIGINAL_SNAPSHOT_DIR
  }
})

describe("loadConfig", () => {
  it("uses /run/autopilot for the default snapshot directory", () => {
    delete process.env.AUTOPILOT_SNAPSHOT_DIR

    expect(loadConfig().snapshotDir).toBe("/run/autopilot/snapshots")
  })

  it("allows AUTOPILOT_SNAPSHOT_DIR to override the default", () => {
    process.env.AUTOPILOT_SNAPSHOT_DIR = "/run/autopilot/custom"

    expect(loadConfig().snapshotDir).toBe("/run/autopilot/custom")
  })
})
