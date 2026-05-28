import { homedir } from "os"
import * as path from "path"
import constants from "./constants.json" with { type: "json" }

const { DEFAULT_SNAPSHOT_DIR } = constants

function validateDir(dir: string): string {
  if (!path.isAbsolute(dir) || dir.includes("\0")) {
    throw new Error(`Invalid snapshot directory: ${dir}`)
  }
  // Reject path traversal attempts explicitly, even though path.resolve would
  // normalize them. This is a security boundary: we do not accept inputs that
  // contain ".." components.
  if (dir.split(path.sep).some((seg) => seg === "..")) {
    throw new Error(`Invalid snapshot directory (path traversal): ${dir}`)
  }
  return path.resolve(dir)
}

function getEnvOrDefault(key: string, fallback: string): string {
  const val = process.env[key]
  return val && val.trim() ? val.trim() : fallback
}

function getEnvList(key: string, fallback: string[]): string[] {
  const val = process.env[key]
  if (!val) return fallback
  return val.split(",").map((p) => p.trim()).filter(Boolean)
}

export interface AutopilotConfig {
  snapshotDir: string
  bwrapPath: string
  shell: string
  bwrapFlags: string[]
  bypassPrefixes: string[]
  debug: boolean
  rootSubvol: string
  maxSystemPromptState: number
}

export function loadConfig(): AutopilotConfig {
  const home = homedir() || (() => { throw new Error("Unable to determine home directory") })()

  return {
    snapshotDir: validateDir(getEnvOrDefault("AUTOPILOT_SNAPSHOT_DIR", DEFAULT_SNAPSHOT_DIR)),
    bwrapPath: getEnvOrDefault("AUTOPILOT_BWRAP_PATH", ""),
    shell: getEnvOrDefault("AUTOPILOT_SHELL", ""),
    bwrapFlags: getEnvOrDefault("AUTOPILOT_BWRAP_FLAGS", "--unshare-pid").split(" ").filter(Boolean),
    bypassPrefixes: getEnvList("AUTOPILOT_BYPASS_PREFIXES", [path.join(home, ".opencode", "")]),
    debug: process.env.AUTOPILOT_DEBUG === "1",
    rootSubvol: getEnvOrDefault("AUTOPILOT_ROOT_SUBVOL", "@rootfs"),
    maxSystemPromptState: parseInt(process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE || "1000", 10),
  }
}

/** Runtime read — allows tests to mutate AUTOPILOT_DEBUG between cases. */
export function getDebugMode(): boolean {
  return process.env.AUTOPILOT_DEBUG === "1"
}

/** Runtime read — allows tests to mutate AUTOPILOT_BWRAP_FLAGS between cases. */
export function getBwrapFlags(configured: string[]): string[] {
  const env = process.env.AUTOPILOT_BWRAP_FLAGS
  if (env !== undefined) return env.split(" ").filter(Boolean)
  return configured
}

/** Runtime read — allows tests to mutate AUTOPILOT_MAX_SYSTEM_PROMPT_STATE between cases. */
export function getMaxSystemPromptState(): number {
  return parseInt(process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE || "1000", 10)
}
