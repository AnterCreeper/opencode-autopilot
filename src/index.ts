import type { Plugin } from "@opencode-ai/plugin"
import { create, deactivate, getState, setSession, setAgent } from "./sandbox.js"
import { onToolExecuteBefore, onToolExecuteAfter, onShellEnv, onSystemTransform } from "./hooks.js"

const AutopilotPlugin: Plugin = async (input) => {
  const client = input.client

  return {
    "chat.message": async (msgInput, _output) => {
      setSession(msgInput.sessionID)
      setAgent(msgInput.agent || "")
      const st = getState()
      if (msgInput.agent === "pilot") {
        if (!st?.active) {
          let parentSessionId: string | undefined

          // Detect fork: if variant is "fork", query parent session ID
          if (msgInput.variant === "fork") {
            try {
              const result = await client.session.get({ path: { id: msgInput.sessionID } })
              parentSessionId = result.data?.parentID
            } catch (err) {
              console.error("[autopilot] Failed to detect fork parent:", err)
            }
          }

          create(undefined, parentSessionId)
        }
      } else {
        if (st?.active) {
          deactivate()
        }
      }
    },

    "tool.execute.before": onToolExecuteBefore,
    "tool.execute.after": onToolExecuteAfter,
    "shell.env": onShellEnv,
    "experimental.chat.system.transform": onSystemTransform,

    "experimental.compaction.autocontinue": async (_input, output) => {
      if (getState()?.active) output.enabled = true
    },
  }
}

export default AutopilotPlugin
