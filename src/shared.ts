import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export const PLUGIN_ID = "heretek.unity-gamedev-kit"

export interface UnityGameDevPluginOptions {
  /** Register the AnkleBreaker Unity MCP server as `unity`. Default: true. */
  enableUnityMcp?: boolean
  /** Command that starts the Unity MCP server. Default: ["npx", "-y", "anklebreaker-unity-mcp@latest"]. */
  unityMcpCommand?: string[]
  /** Passed to the Unity MCP server as UNITY_HUB_PATH, for Unity Hub tools. */
  unityHubPath?: string
  /** Register the Context7 docs MCP server as `context7`. Default: true. */
  enableContext7?: boolean
  /** Paths the built-in `plan` agent may edit (OpenSpec planning files). Default: openspec, docs, AGENTS.md. */
  planWritablePaths?: string[]
  /** Deny edits to Unity's generated folders and to credential files. Default: true. */
  protectGeneratedFiles?: boolean
  /** Append Unity/OpenSpec rules to the agent's system prompt. Default: true. */
  injectSystemPrompt?: boolean
  /**
   * Extra skill folders to load. `npx skills add --agent opencode` installs into `.agents/skills`,
   * which OpenCode V2 does not scan by itself. Default: [".agents/skills", "~/.agents/skills"].
   */
  skillDirectories?: string[]
  /** Run the full bootstrap once per project when the plugin loads, without asking. Default: false. */
  autoBootstrapOnLoad?: boolean
  /** Include @aerovato/operator-helper (`operator-helper install opencode-v2`) in the bootstrap. Default: true. */
  installOperatorHelper?: boolean
}

export const DEFAULT_UNITY_MCP_COMMAND = ["npx", "-y", "anklebreaker-unity-mcp@latest"]
export const CONTEXT7_MCP_COMMAND = ["npx", "-y", "@upstash/context7-mcp@latest"]
export const DEFAULT_PLAN_WRITABLE_PATHS = ["openspec/*", "docs/*", "AGENTS.md"]
export const DEFAULT_SKILL_DIRECTORIES = [".agents/skills", "~/.agents/skills"]

export const SKILL_PACKS: ReadonlyArray<{ label: string; args: string[] }> = [
  { label: "gamedev-skills/awesome-gamedev-agent-skills", args: ["gamedev-skills/awesome-gamedev-agent-skills"] },
  { label: "vercel-labs/skills (find-skills)", args: ["vercel-labs/skills", "--skill", "find-skills"] },
  { label: "unity-technologies/industry-ai-workflows", args: ["unity-technologies/industry-ai-workflows"] },
  { label: "unity-technologies/unity-agent-plugin", args: ["unity-technologies/unity-agent-plugin"] },
  { label: "unity-technologies/skills", args: ["unity-technologies/skills"] },
  { label: "mattpocock/skills", args: ["mattpocock/skills"] },
]

/** Folders Unity regenerates; agents should never write into them. */
export const UNITY_GENERATED_DIRS = ["Library", "Temp", "Obj", "obj", "Logs", "MemoryCaptures", "UserSettings"]

export const SYSTEM_PROMPT = `
## Unity game development rules (from @heretek-ai/unity.gamedev.kit)
1. Spec first: check \`openspec/specs/\` and \`openspec/changes/\` before building new gameplay systems or scene changes. Use the \`grill-me\` and \`write-a-prd\` skills to settle mechanics before writing a spec.
2. Unity Editor via MCP: bind the editor with \`unity_list_instances\` and \`unity_select_instance\` first, then use \`unity_*\` tools (and \`unity_list_advanced_tools\`) for GameObjects, prefabs, ScriptableObjects and scenes.
3. Never hand-edit serialized Unity YAML (\`.unity\`, \`.prefab\`, \`.asset\`) when an MCP tool can make the change, and never write into \`Library/\`, \`Temp/\`, \`Obj/\`, \`Logs/\` or \`UserSettings/\`.
4. After changing C# under \`Assets/\` or \`Packages/\`, check the Unity console for compiler errors and run EditMode/PlayMode tests until they pass.
`.trim()

export const COMMANDS = {
  "unity-bootstrap": {
    description: "Install the Unity/gamedev skill packs and initialize OpenSpec in this project",
    template:
      "Run the `gamedev_bootstrap_stack` tool to install the Unity and gamedev skill packs and initialize OpenSpec, then run `gamedev_status` and report what is set up and what is still missing.",
  },
  "unity-connect": {
    description: "Find running Unity Editors through the Unity MCP server and report editor state",
    template:
      "Call `unity_list_instances`, select the right Unity project with `unity_select_instance`, then check `unity_editor_state` and the console for compilation errors. Summarize the active scene and editor status. If no editor is found, tell me to install the AnkleBreaker Unity MCP package in Unity (Package Manager, Add package from git URL: https://github.com/AnkleBreaker-Studio/unity-mcp-plugin.git) and open the project.",
  },
  "spec-feature": {
    description: "Interview a game feature idea with grill-me and draft an OpenSpec change",
    template:
      "Load the `grill-me` and `write-a-prd` skills to clarify the design of this Unity feature. Once we agree on mechanics, Unity architecture and acceptance criteria, create or update an OpenSpec change under `openspec/changes/`.",
  },
  "unity-verify": {
    description: "Verify the active OpenSpec change against the Unity console, scene state and tests",
    template:
      "Verify the current implementation against the specs in `openspec/`: check the Unity console for zero compilation errors through the `unity` MCP tools, run EditMode and PlayMode tests, and report any drift from the spec.",
  },
} as const

export function withArguments(template: string, args: string | undefined) {
  const extra = args?.trim()
  return extra ? `${template}\n\n${extra}` : template
}

/** Unity project roots inside `directory`: the directory itself and its immediate children that hold Assets/ and ProjectSettings/. */
export function findUnityRoots(directory: string): string[] {
  const isUnity = (dir: string) => existsSync(join(dir, "Assets")) && existsSync(join(dir, "ProjectSettings"))
  const roots: string[] = []
  if (isUnity(directory)) roots.push("")
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (isUnity(join(directory, entry.name))) roots.push(`${entry.name}/`)
    }
  } catch {
    // Unreadable directory: treat as no nested projects.
  }
  return roots
}

/** Returns a denial reason when `resource` (a path relative to the project, or absolute) must not be edited. */
export function protectedReason(resource: string, unityRoots: readonly string[], directory: string): string | undefined {
  let path = resource.replaceAll("\\", "/")
  const base = directory.replaceAll("\\", "/").replace(/\/$/, "")
  if (path.startsWith(`${base}/`)) path = path.slice(base.length + 1)
  const name = path.slice(path.lastIndexOf("/") + 1)

  for (const root of unityRoots) {
    for (const dir of UNITY_GENERATED_DIRS) {
      if (path.startsWith(`${root}${dir}/`)) {
        return `${root}${dir}/ is generated by Unity. Change the source asset or use the unity_* MCP tools instead.`
      }
    }
  }

  const sensitive =
    (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) ||
    /\.(pem|key|pfx|p12|keystore|jks)$/i.test(name) ||
    /^id_(rsa|ed25519|ecdsa)/.test(name)
  if (sensitive) return `${name} looks like a credential or signing key, so the Unity gamedev kit blocks edits to it.`
  return undefined
}

export interface StackStatus {
  projectDirectory: string
  unityProjects: string[]
  unityMcpPackageInstalled: boolean
  openspecInitialized: boolean
  agentsMd: boolean
  skillDirectories: string[]
}

export function inspectStackStatus(directory: string): StackStatus {
  const unityRoots = findUnityRoots(directory)
  const unityMcpPackageInstalled = unityRoots.some((root) => {
    try {
      const manifest = readFileSync(join(directory, root, "Packages", "manifest.json"), "utf8")
      return /unity-mcp-plugin|com\.anklebreaker/i.test(manifest)
    } catch {
      return false
    }
  })
  return {
    projectDirectory: directory,
    unityProjects: unityRoots.map((root) => root || "."),
    unityMcpPackageInstalled,
    openspecInitialized: existsSync(join(directory, "openspec")),
    agentsMd: existsSync(join(directory, "AGENTS.md")),
    skillDirectories: [".opencode/skills", ".agents/skills", ".claude/skills"].filter((dir) =>
      existsSync(join(directory, dir)),
    ),
  }
}

export interface SkillFile {
  name?: string
  description?: string
  content: string
}

export function parseSkillFile(raw: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const field = (key: string) =>
    match
      ? new RegExp(`^${key}:\\s*(.+)$`, "m").exec(match[1])?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2")
      : undefined
  return {
    name: field("name"),
    description: field("description"),
    content: (match ? raw.slice(match[0].length) : raw).trim(),
  }
}

/** Reads `<dir>/<skill>/SKILL.md` for each configured directory, first occurrence of a name wins. */
export function loadSkillDirectories(directories: readonly string[], projectDirectory: string) {
  const skills = new Map<string, SkillFile & { name: string; path: string }>()
  for (const entry of directories) {
    const expanded = entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry
    const root = isAbsolute(expanded) ? expanded : join(projectDirectory, expanded)
    let children: string[]
    try {
      children = readdirSync(root)
    } catch {
      continue
    }
    for (const child of children.sort()) {
      const path = join(root, child, "SKILL.md")
      try {
        const parsed = parseSkillFile(readFileSync(path, "utf8"))
        const name = parsed.name || child
        if (!skills.has(name)) skills.set(name, { ...parsed, name, path })
      } catch {
        // Not a skill folder.
      }
    }
  }
  return [...skills.values()]
}
