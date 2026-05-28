import { SandboxManager, SandboxState } from "./manager.js"

const defaultManager = new SandboxManager()

export type { SandboxState }

export function saveOriginalArgs(callID: string, args: any): void {
  defaultManager.saveOriginalArgs(callID, args)
}

export function restoreOriginalArgs(callID: string, args: any): void {
  defaultManager.restoreOriginalArgs(callID, args)
}

export function getSessionId() { return defaultManager.getSessionId() }
export function setSession(sessionID: string) { defaultManager.setSession(sessionID) }
export function getAgent() { return defaultManager.getAgent() }
export function setAgent(agent: string) { defaultManager.setAgent(agent) }

export function getState(): Readonly<SandboxState> | undefined {
  return defaultManager.getState()
}

export function create(projectDir?: string, parentSessionId?: string): SandboxState {
  return defaultManager.create(projectDir, parentSessionId)
}

export function deactivate(): void {
  defaultManager.deactivate()
}

export function discard(): void {
  defaultManager.discard()
}

export function discardSession(st: SandboxState): void {
  defaultManager.discardSession(st)
}

export function listSnapshots(): Array<{ id: string; snapshotPath: string; active: boolean }> {
  return defaultManager.listSnapshots()
}

export function discardAll(): void {
  defaultManager.discardAll()
}

export function ensureSandboxHealthy(st: SandboxState): void {
  defaultManager.ensureSandboxHealthy(st)
}

export function setBypassPrefixes(prefixes: string[]): void {
  defaultManager.setBypassPrefixes(prefixes)
}

export function toSandboxPath(original: string): string {
  return defaultManager.toSandboxPath(original)
}

export function wrapNsenterCommand(st: SandboxState, command: string, workdir?: string): string {
  return defaultManager.wrapNsenterCommand(st, command, workdir)
}

export function maskPaths(st: SandboxState, text: string): string {
  return defaultManager.maskPaths(st, text)
}

export { SandboxManager }
