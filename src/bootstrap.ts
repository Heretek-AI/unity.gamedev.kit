import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { SKILL_PACKS } from "./shared.js"

export interface BootstrapOptions {
  installSkills?: boolean
  initOpenSpec?: boolean
  installOperatorHelper?: boolean
}

export interface BootstrapStep {
  label: string
  command: string
  args: string[]
  /** Skip this step when the function returns a reason. */
  skip?: () => string | undefined
}

export function bootstrapSteps(directory: string, options: BootstrapOptions = {}): BootstrapStep[] {
  const steps: BootstrapStep[] = []
  if (options.installSkills ?? true) {
    for (const pack of SKILL_PACKS) {
      steps.push({
        label: `Skill pack ${pack.label}`,
        command: "npx",
        args: ["-y", "skills@latest", "add", ...pack.args, "--agent", "opencode", "--yes"],
      })
    }
  }
  if (options.initOpenSpec ?? true) {
    steps.push({
      label: "OpenSpec CLI",
      command: "npm",
      args: ["install", "--global", "@fission-ai/openspec@latest"],
    })
    steps.push({
      label: "OpenSpec project setup",
      command: "npx",
      args: ["-y", "@fission-ai/openspec@latest", "init", "--tools", "opencode", "--no-animation"],
      skip: () => (existsSync(join(directory, "openspec")) ? "openspec/ already exists" : undefined),
    })
  }
  if (options.installOperatorHelper ?? true) {
    steps.push({
      label: "Operator Helper CLI",
      command: "npm",
      args: ["install", "--global", "@aerovato/operator-helper@latest"],
    })
    steps.push({
      label: "Operator Helper for OpenCode V2",
      command: "operator-helper",
      args: ["install", "opencode-v2"],
    })
  }
  return steps
}

export interface StepResult {
  label: string
  status: "ok" | "failed" | "skipped"
  detail: string
}

const TAIL = 1500

/** Runs one command without a TTY. On Windows, npm/npx are .cmd shims, which Node only starts through a shell. */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32"
    const child = spawn(command, windows ? args.map(quoteWindowsArg) : args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs ?? 300_000,
      shell: windows,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    })
    let output = ""
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-TAIL * 4)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
}

function quoteWindowsArg(arg: string) {
  return /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`
}

export async function runBootstrap(
  directory: string,
  options: BootstrapOptions = {},
  hooks: { signal?: AbortSignal; onStep?: (label: string, index: number, total: number) => Promise<void> | void } = {},
): Promise<StepResult[]> {
  const steps = bootstrapSteps(directory, options)
  const results: StepResult[] = []
  for (const [index, step] of steps.entries()) {
    hooks.signal?.throwIfAborted()
    const skipped = step.skip?.()
    if (skipped) {
      results.push({ label: step.label, status: "skipped", detail: skipped })
      continue
    }
    await hooks.onStep?.(step.label, index + 1, steps.length)
    try {
      const { code, output } = await runCommand(step.command, step.args, { cwd: directory, signal: hooks.signal })
      results.push({
        label: step.label,
        status: code === 0 ? "ok" : "failed",
        detail: `$ ${step.command} ${step.args.join(" ")}\n${output.trim().slice(-TAIL)}`.trim(),
      })
    } catch (error) {
      if (hooks.signal?.aborted) throw error
      results.push({
        label: step.label,
        status: "failed",
        detail: `$ ${step.command} ${step.args.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return results
}

export function formatResults(results: readonly StepResult[]) {
  const mark = { ok: "OK", failed: "FAILED", skipped: "SKIPPED" } as const
  const summary = results.map((result) => `[${mark[result.status]}] ${result.label}`).join("\n")
  const failures = results
    .filter((result) => result.status === "failed")
    .map((result) => `--- ${result.label}\n${result.detail}`)
    .join("\n\n")
  return failures ? `${summary}\n\nFailure output:\n${failures}` : summary
}
