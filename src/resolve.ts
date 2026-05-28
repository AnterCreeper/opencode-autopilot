import { accessSync, constants } from "fs"
import * as path from "path"
import type { AutopilotConfig } from "./config.js"

const cache = new Map<string, string>()

function findInPath(command: string): string | undefined {
  const envPath = process.env.PATH || ""
  const dirs = envPath.split(":").filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not executable or not found in this dir
    }
  }
  return undefined
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the absolute path of an external executable.
 * Uses env override first, then PATH traversal, then the provided fallback.
 * Results are cached per process.
 */
export function resolveBinary(command: string, envOverride?: string, fallback?: string): string {
  const key = envOverride ? `${command}:${envOverride}` : command
  if (cache.has(key)) return cache.get(key)!

  let resolved: string | undefined
  if (envOverride && envOverride.trim()) {
    const override = envOverride.trim()
    if (!isExecutable(override)) {
      throw new Error(`Configured binary "${command}" is not executable: ${override}`)
    }
    resolved = override
  }
  if (!resolved) {
    resolved = findInPath(command)
  }
  if (!resolved && fallback) {
    resolved = isExecutable(fallback) ? fallback : undefined
  }
  if (!resolved) {
    throw new Error(
      `Required binary "${command}" not found in PATH. ` +
      (envOverride ? `Override with env var if installed elsewhere. ` : ``) +
      `Install ${command} or add it to PATH.`
    )
  }
  cache.set(key, resolved)
  return resolved
}

/**
 * Pre-resolve all binaries used by the sandbox at startup.
 * Fails fast with a clear message if anything is missing.
 */
export function resolveAllBinaries(config: Pick<AutopilotConfig, "bwrapPath" | "shell">): Record<string, string> {
  return {
    bwrap: resolveBinary("bwrap", config.bwrapPath, "/usr/bin/bwrap"),
    bash: resolveBinary("bash", config.shell, "/bin/bash"),
    btrfs: resolveBinary("btrfs"),
    findmnt: resolveBinary("findmnt"),
    mountpoint: resolveBinary("mountpoint"),
    mount: resolveBinary("mount"),
    ps: resolveBinary("ps"),
    nsenter: resolveBinary("nsenter"),
    base64: resolveBinary("base64"),
    test: resolveBinary("test"),
  }
}
