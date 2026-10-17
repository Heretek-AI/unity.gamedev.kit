import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin, Skill } from "@opencode/plugin"
import { formatResults, runBootstrap } from "./bootstrap.js"
import {
  COMMANDS,
  CONTEXT7_MCP_COMMAND,
  DEFAULT_PLAN_WRITABLE_PATHS,
  DEFAULT_SKILL_DIRECTORIES,
  DEFAULT_UNITY_MCP_COMMAND,
  PLUGIN_ID,
  SYSTEM_PROMPT,
  type UnityGameDevPluginOptions,
  findUnityRoots,
  inspectStackStatus,
  loadSkillDirectories,
  parseSkillFile,
  protectedReason,
  withArguments,
} from "./shared.js"

const SKILL_FILE = new URL("../skills/unity-openspec-workflow/SKILL.md", import.meta.url)

export const v2: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = ctx.options as UnityGameDevPluginOptions
    const directory = ctx.location.directory
    const unityRoots = findUnityRoots(directory)

    await ctx.mcp.transform((editor) => {
      if (options.enableUnityMcp !== false && !editor.get("unity")) {
        editor.set("unity", {
          type: "local",
          command: options.unityMcpCommand ?? DEFAULT_UNITY_MCP_COMMAND,
          ...(options.unityHubPath ? { environment: { UNITY_HUB_PATH: options.unityHubPath } } : {}),
          // The first `npx` run downloads the server, which can outlast the default startup timeout.
          timeout: { startup: 120_000 },
        })
      }
      if (options.enableContext7 !== false && !editor.get("context7")) {
        editor.set("context7", { type: "local", command: CONTEXT7_MCP_COMMAND, timeout: { startup: 120_000 } })
      }
    })

    const bundled = { ...parseSkillFile(readFileSync(SKILL_FILE, "utf8")), path: fileURLToPath(SKILL_FILE) }
    const skillDirectories = options.skillDirectories ?? DEFAULT_SKILL_DIRECTORIES
    const installed = { skills: loadSkillDirectories(skillDirectories, directory) }
    await ctx.skill.transform((editor) => {
      for (const skill of [{ ...bundled, name: "unity-openspec-workflow" }, ...installed.skills]) {
        if (editor.get(skill.name)) continue
        editor.add({
          id: skill.name as Skill.ID,
          name: skill.name as Skill.Name,
          description: skill.description,
          path: skill.path as Skill.Info["path"],
          content: skill.content,
        })
      }
    })
    const reloadSkills = async () => {
      installed.skills = loadSkillDirectories(skillDirectories, directory)
      await ctx.skill.reload()
    }

    // The built-in plan agent denies every edit, and a configured deny never reaches permission
    // hooks, so OpenSpec's planning files have to be re-allowed as later rules on the agent itself.
    const planWritable = options.planWritablePaths ?? DEFAULT_PLAN_WRITABLE_PATHS
    await ctx.agent.transform((editor) => {
      if (!editor.get("plan")) return
      editor.update("plan", (agent) => {
        for (const resource of planWritable) agent.permissions.push({ action: "edit", resource, effect: "allow" })
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "gamedev",
        description: "Unity game development setup: skill packs, OpenSpec and project readiness checks",
      })
      editor.add({
        name: "bootstrap_stack",
        description:
          "Install the Unity and gamedev skill packs (npx skills add), the OpenSpec CLI and project setup, and optionally @aerovato/operator-helper. Runs npm global installs, so it asks the user first.",
        input: {
          type: "object",
          properties: {
            installSkills: { type: "boolean", description: "Install the six skill packs. Default: true." },
            initOpenSpec: { type: "boolean", description: "Install OpenSpec and run `openspec init`. Default: true." },
            installOperatorHelper: {
              type: "boolean",
              description: "Install @aerovato/operator-helper and run `operator-helper install opencode-v2`.",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "gamedev", codemode: true },
        execute: async (input, context) => {
          const args = (input ?? {}) as { installSkills?: boolean; initOpenSpec?: boolean; installOperatorHelper?: boolean }
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "gamedev_bootstrap_stack",
            resources: [directory],
            save: ["*"],
          })
          const results = await runBootstrap(
            directory,
            {
              installSkills: args.installSkills,
              initOpenSpec: args.initOpenSpec,
              installOperatorHelper: args.installOperatorHelper ?? options.installOperatorHelper,
            },
            {
              signal: context.signal,
              onStep: (label, index, total) => context.progress({ status: `${index}/${total} ${label}` }),
            },
          )
          await reloadSkills()
          return { content: formatResults(results), metadata: { results } }
        },
      })
      editor.add({
        name: "status",
        description:
          "Report whether this workspace is a Unity project, whether the AnkleBreaker Unity MCP package is installed in it, and whether OpenSpec and skill folders are set up.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "gamedev", codemode: true },
        execute: async () => ({ content: JSON.stringify(inspectStackStatus(directory), null, 2) }),
      })
    })

    await ctx.command.transform((editor) => {
      for (const [name, command] of Object.entries(COMMANDS)) {
        editor.add({
          name,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: withArguments(command.template, prompt.text),
            })
          },
        })
      }
    })

    if (options.protectGeneratedFiles !== false) {
      await ctx.permission.hook("evaluate", (event) => {
        if (event.action !== "edit" || event.effect === "deny") return
        for (const resource of event.resources) {
          const reason = protectedReason(resource, unityRoots, directory)
          if (!reason) continue
          event.effect = "deny"
          event.message = reason
          return
        }
      })
    }

    if (options.injectSystemPrompt !== false) {
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: SYSTEM_PROMPT })
      })
    }

    if (!options.autoBootstrapOnLoad) return
    const key = `bootstrapped/${ctx.location.project.id}`
    if (await ctx.storage.get(key)) return
    const controller = new AbortController()
    void runBootstrap(directory, { installOperatorHelper: options.installOperatorHelper }, { signal: controller.signal })
      .then(async (results) => {
        console.log(`[${PLUGIN_ID}] bootstrap finished\n${formatResults(results)}`)
        await ctx.storage.set(key, true)
        await reloadSkills()
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error(`[${PLUGIN_ID}] bootstrap failed`, error)
      })
    return () => controller.abort()
  },
}
