import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "../dist/index.js"
import { bootstrapSteps } from "../dist/bootstrap.js"
import { findUnityRoots, protectedReason } from "../dist/shared.js"

function unityProject() {
  const dir = mkdtempSync(join(tmpdir(), "unity-kit-"))
  mkdirSync(join(dir, "Assets"))
  mkdirSync(join(dir, "ProjectSettings"))
  mkdirSync(join(dir, "Packages"))
  writeFileSync(
    join(dir, "Packages", "manifest.json"),
    JSON.stringify({ dependencies: { "com.anklebreaker.unity-mcp": "https://github.com/AnkleBreaker-Studio/unity-mcp-plugin.git" } }),
  )
  mkdirSync(join(dir, ".agents", "skills", "tdd"), { recursive: true })
  writeFileSync(join(dir, ".agents", "skills", "tdd", "SKILL.md"), '---\nname: tdd\ndescription: "Red, green, refactor"\n---\n\nWrite the test first.\n')
  return dir
}

/** A minimal stand-in for the V2 plugin context that records what setup registers. */
function fakeContext(directory, options = {}) {
  const state = { mcp: new Map(), skills: [], tools: [], commands: [], hooks: {}, prompts: [], asserts: [] }
  const plan = { id: "plan", permissions: [{ action: "edit", resource: "*", effect: "deny" }] }
  const registration = { dispose: async () => {} }
  const ctx = {
    options,
    location: { directory, project: { id: "proj", directory, canonical: directory } },
    mcp: {
      transform: async (cb) => {
        cb({ get: (n) => state.mcp.get(n), set: (n, c) => state.mcp.set(n, c), list: () => [...state.mcp] })
        return registration
      },
    },
    skill: {
      transform: async (cb) => {
        cb({ get: (id) => state.skills.find((s) => s.id === id), add: (s) => state.skills.push(s) })
        return registration
      },
      reload: async () => {},
    },
    agent: {
      transform: async (cb) => {
        cb({ get: (id) => (id === "plan" ? plan : undefined), update: (id, fn) => id === "plan" && fn(plan) })
        return registration
      },
    },
    tool: {
      transform: async (cb) => {
        cb({ namespace: () => {}, add: (t) => state.tools.push(t) })
        return registration
      },
    },
    command: {
      transform: async (cb) => {
        cb({ add: (c) => state.commands.push(c) })
        return registration
      },
    },
    permission: {
      hook: async (name, cb) => ((state.hooks[`permission.${name}`] = cb), registration),
      assert: async (input) => {
        state.asserts.push(input)
        throw new Error("declined")
      },
    },
    session: {
      hook: async (name, cb) => ((state.hooks[`session.${name}`] = cb), registration),
      prompt: async (input) => state.prompts.push(input),
    },
    storage: { get: async () => undefined, set: async () => {} },
  }
  return { ctx, state, plan }
}

test("exports a V2 definition and a V1 server function", () => {
  assert.equal(typeof plugin.id, "string")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("V2 setup registers MCP servers, skill, tools, commands and plan rules", async () => {
  const dir = unityProject()
  const { ctx, state, plan } = fakeContext(dir, { unityHubPath: "C:/Hub/Unity Hub.exe" })
  await plugin.setup(ctx)

  assert.deepEqual(state.mcp.get("unity").command, ["npx", "-y", "anklebreaker-unity-mcp@latest"])
  assert.equal(state.mcp.get("unity").environment.UNITY_HUB_PATH, "C:/Hub/Unity Hub.exe")
  assert.ok(state.mcp.get("context7"))
  assert.equal(state.skills[0].id, "unity-openspec-workflow")
  assert.match(state.skills[0].content, /unity_list_instances/)
  assert.deepEqual(
    { id: state.skills[1].id, description: state.skills[1].description, content: state.skills[1].content },
    { id: "tdd", description: "Red, green, refactor", content: "Write the test first." },
  )
  assert.deepEqual(
    state.tools.map((t) => t.name),
    ["bootstrap_stack", "status"],
  )
  assert.deepEqual(
    state.commands.map((c) => c.name),
    ["unity-bootstrap", "unity-connect", "spec-feature", "unity-verify"],
  )
  assert.deepEqual(plan.permissions.at(-1), { action: "edit", resource: "AGENTS.md", effect: "allow" })

  const status = JSON.parse((await state.tools[1].execute({}, {})).content)
  assert.equal(status.unityMcpPackageInstalled, true)
  assert.deepEqual(status.unityProjects, ["."])
})

test("bootstrap tool asks permission before installing anything", async () => {
  const { ctx, state } = fakeContext(unityProject())
  await plugin.setup(ctx)
  const context = { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: AbortSignal.timeout(5000), progress: async () => {} }
  await assert.rejects(state.tools[0].execute({}, context), /declined/)
  assert.equal(state.asserts[0].action, "gamedev_bootstrap_stack")
})

test("commands forward the user's arguments", async () => {
  const { ctx, state } = fakeContext(unityProject())
  await plugin.setup(ctx)
  const spec = state.commands.find((c) => c.name === "spec-feature")
  await spec.execute({ sessionID: "s", delivery: "steer", prompt: { text: "double jump" } })
  assert.match(state.prompts[0].text, /grill-me[\s\S]*double jump$/)
})

test("permission hook denies generated Unity folders and key files only", async () => {
  const dir = unityProject()
  const { ctx, state } = fakeContext(dir)
  await plugin.setup(ctx)
  const evaluate = (resource) => {
    const event = { action: "edit", resources: [resource], effect: "allow" }
    state.hooks["permission.evaluate"](event)
    return event.effect
  }
  assert.equal(evaluate("Library/ScriptAssemblies/a.dll"), "deny")
  assert.equal(evaluate(join(dir, "Temp", "x.txt")), "deny")
  assert.equal(evaluate(".env.local"), "deny")
  assert.equal(evaluate("Assets/Signing/release.keystore"), "deny")
  assert.equal(evaluate("Assets/Plugins/Library/Thing.cs"), "allow")
  assert.equal(evaluate(".env.example"), "allow")
  assert.equal(evaluate("Assets/Scripts/Player.cs"), "allow")
})

test("nested Unity projects are detected one level down", () => {
  const root = mkdtempSync(join(tmpdir(), "unity-kit-root-"))
  mkdirSync(join(root, "Game", "Assets"), { recursive: true })
  mkdirSync(join(root, "Game", "ProjectSettings"))
  assert.deepEqual(findUnityRoots(root), ["Game/"])
  assert.ok(protectedReason("Game/Library/x", ["Game/"], root))
  assert.equal(protectedReason("Library/x", ["Game/"], root), undefined)
})

test("bootstrap steps use real CLI flags", () => {
  const steps = bootstrapSteps(mkdtempSync(join(tmpdir(), "unity-kit-steps-")))
  const init = steps.find((s) => s.label === "OpenSpec project setup")
  assert.deepEqual(init.args.slice(2), ["init", "--tools", "opencode", "--no-animation"])
  for (const step of steps.filter((s) => s.label.startsWith("Skill pack"))) {
    assert.ok(step.args.includes("--agent") && step.args.includes("opencode"), step.label)
  }
  assert.equal(bootstrapSteps(".", { installOperatorHelper: false }).some((s) => s.command === "operator-helper"), false)
})

test("V1 server adds MCP servers and commands without overriding user config", async () => {
  const dir = unityProject()
  const hooks = await plugin.server({ directory: dir }, {})
  const config = { mcp: { context7: { type: "remote", url: "https://example.com" } }, command: {} }
  await hooks.config(config)
  assert.equal(config.mcp.unity.type, "local")
  assert.equal(config.mcp.context7.type, "remote")
  assert.match(config.command["spec-feature"].template, /\$ARGUMENTS$/)
  await assert.rejects(hooks["tool.execute.before"]({ tool: "write" }, { args: { filePath: join(dir, "Library", "a") } }))
})
