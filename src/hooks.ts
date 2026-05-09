import { create, getAgent, getState, setSession, toSandboxPath, wrapBashCommand, maskPaths, saveOriginalArgs, restoreOriginalArgs } from "./sandbox.js"

function isDebugMode(): boolean {
  return process.env.AUTOPILOT_DEBUG === "1"
}

// Track last injected state per session to avoid duplicate system prompts
const systemPromptState = new Map<string, boolean>()
const MAX_SYSTEM_PROMPT_STATE = parseInt(process.env.AUTOPILOT_MAX_SYSTEM_PROMPT_STATE || "1000", 10)

function setSystemPromptState(sessionId: string, active: boolean): void {
  if (!systemPromptState.has(sessionId) && systemPromptState.size >= MAX_SYSTEM_PROMPT_STATE) {
    const firstKey = systemPromptState.keys().next().value
    if (firstKey) systemPromptState.delete(firstKey)
  }
  systemPromptState.set(sessionId, active)
}

function rewritePatchPath(rawPath: string): string {
  const unquoted = rawPath.match(/^"(.*)"$/)?.[1] ?? rawPath
  if (unquoted === "/dev/null" || unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return rawPath
  }

  const rewritten = toSandboxPath(unquoted)
  return rawPath.startsWith("\"") && rawPath.endsWith("\"") ? JSON.stringify(rewritten) : rewritten
}

function rewriteApplyPatch(patchText: string): string {
  return patchText
    .replace(
      /^(\*\*\* (?:Add File|Update File|Delete File|Move to):\s+)(.+)$/gm,
      (_match, prefix, rawPath) => prefix + rewritePatchPath(rawPath),
    )
    .replace(
      /^(\+\+\+ |--- )("?)([^\t\n"]+)\2/gm,
      (_match, prefix, quote, rawPath) => prefix + (quote ? JSON.stringify(rewritePatchPath(rawPath)) : rewritePatchPath(rawPath)),
    )
}

export async function onToolExecuteAfter(
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
): Promise<void> {
  setSession(input.sessionID)
  const st = getState()
  if (!st?.active) return

  // Restore original args so transcript shows clean paths, not snapshot paths
  restoreOriginalArgs(input.callID, input.args)

  if (isDebugMode()) {
    output.output = `[AUTOPILOT DEBUG] Raw command:\n${JSON.stringify(input.args, null, 2)}\n---\n` + output.output
    return
  }

  output.title = maskPaths(st, output.title)
  output.output = maskPaths(st, output.output)
  if (output.metadata?.filepath) output.metadata.filepath = maskPaths(st, output.metadata.filepath)
  if (output.metadata?.output) output.metadata.output = maskPaths(st, output.metadata.output)
}

export async function onToolExecuteBefore(
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
): Promise<void> {
  setSession(input.sessionID)

  const st = getState()
  if (!st?.active) {
    if (getAgent() === "autopilot") {
      create()
    } else {
      return
    }
  }

  // Save original args for restoration in after hook (transcript cleanliness)
  saveOriginalArgs(input.callID, output.args)

  // Rewrite in-place: opencode executes the original args object after this hook.
  // The after hook restores it so transcripts still show logical paths.
  const sandboxArgs = JSON.parse(JSON.stringify(output.args))

  switch (input.tool) {
    case "bash":
      sandboxArgs.command = wrapBashCommand(sandboxArgs.command)
      if (sandboxArgs.workdir) sandboxArgs.workdir = toSandboxPath(sandboxArgs.workdir)
      break

    case "write":
    case "edit":
    case "read":
    case "lsp":
      if (sandboxArgs.filePath) sandboxArgs.filePath = toSandboxPath(sandboxArgs.filePath)
      break

    case "glob":
    case "grep":
      if (sandboxArgs.path) sandboxArgs.path = toSandboxPath(sandboxArgs.path)
      break

    case "apply_patch":
      if (sandboxArgs.patchText) sandboxArgs.patchText = rewriteApplyPatch(String(sandboxArgs.patchText))
      break
  }

  for (const key of Object.keys(output.args)) delete output.args[key]
  Object.assign(output.args, sandboxArgs)
}

export async function onShellEnv(
  _input: { cwd: string; sessionID?: string; callID?: string },
  output: { env: Record<string, string> },
): Promise<void> {
  if (_input.sessionID) setSession(_input.sessionID)
  const st = getState()
  if (!st?.active) return
  output.env.SANDBOX_ROOT = st.snapshotPath
  output.env.AUTOPILOT_ACTIVE = "1"
}

export async function onSystemTransform(
  input: { sessionID?: string },
  output: { system: string[] },
): Promise<void> {
  if (!input.sessionID) return
  setSession(input.sessionID)
  const st = getState()
  if (!st) return

  const current = st.active
  const last = systemPromptState.get(input.sessionID!)
  if (last === current) return  // already injected for this state

  if (current) {
    output.system.push(
      `[AUTOPILOT ACTIVE] Sandbox active. Do NOT start system services or manage processes. All writes are COW-isolated.`,
    )
  } else {
    output.system.push(
      `[AUTOPILOT REVIEW] Snapshot preserved. Review changes before cleanup.`,
    )
  }
  setSystemPromptState(input.sessionID!, current)
}
