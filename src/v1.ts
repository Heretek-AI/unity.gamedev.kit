import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import {
  COMMANDS,
  CONTEXT7_MCP_COMMAND,
  DEFAULT_UNITY_MCP_COMMAND,
  SYSTEM_PROMPT,
  type UnityGameDevPluginOptions,
  findUnityRoots,
  protectedReason,
} from "./shared.js"

/**
 * OpenCode 1.x (1.18.29+) entrypoint. V1 has no plugin tool registry without zod, so the
 * bootstrap is exposed through `/unity-bootstrap` running the package's CLI instead.
 */
export const server: V1Plugin = async (input, rawOptions) => {
  const options = (rawOptions ?? {}) as UnityGameDevPluginOptions
  const unityRoots = findUnityRoots(input.directory)

  return {
    config: async (config) => {
      config.mcp ??= {}
      if (options.enableUnityMcp !== false && !config.mcp.unity) {
        config.mcp.unity = {
          type: "local",
          command: options.unityMcpCommand ?? DEFAULT_UNITY_MCP_COMMAND,
          enabled: true,
          ...(options.unityHubPath ? { environment: { UNITY_HUB_PATH: options.unityHubPath } } : {}),
        }
      }
      if (options.enableContext7 !== false && !config.mcp.context7) {
        config.mcp.context7 = { type: "local", command: CONTEXT7_MCP_COMMAND, enabled: true }
      }

      config.command ??= {}
      for (const [name, command] of Object.entries(COMMANDS)) {
        if (config.command[name]) continue
        const template =
          name === "unity-bootstrap"
            ? "Run `npx -y @heretek-ai/unity.gamedev.kit` in the project directory with the bash tool to install the Unity and gamedev skill packs and initialize OpenSpec, then summarize its output."
            : `${command.template}\n\n$ARGUMENTS`
        config.command[name] = { description: command.description, template }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (options.injectSystemPrompt !== false) output.system.push(SYSTEM_PROMPT)
    },

    "tool.execute.before": async (event, output) => {
      if (options.protectGeneratedFiles === false) return
      if (event.tool !== "write" && event.tool !== "edit" && event.tool !== "patch") return
      const filePath = (output.args as { filePath?: unknown } | undefined)?.filePath
      if (typeof filePath !== "string") return
      const reason = protectedReason(filePath, unityRoots, input.directory)
      if (reason) throw new Error(reason)
    },
  }
}
