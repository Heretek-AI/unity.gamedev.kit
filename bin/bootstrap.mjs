#!/usr/bin/env node
// Installs the Unity/gamedev skill packs, OpenSpec and (optionally) Operator Helper into the
// current directory. Same steps as the `gamedev_bootstrap_stack` tool, for use outside OpenCode.
import { formatResults, runBootstrap } from "../dist/bootstrap.js"

const args = new Set(process.argv.slice(2))
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: npx @heretek-ai/unity.gamedev.kit [--no-skills] [--no-openspec] [--no-operator-helper]

Run it from your Unity project folder. Installs:
  - six skill packs with \`npx skills add ... --agent opencode\`
  - the OpenSpec CLI, then \`openspec init --tools opencode\` if openspec/ is missing
  - @aerovato/operator-helper and \`operator-helper install opencode-v2\``)
  process.exit(0)
}

const results = await runBootstrap(
  process.cwd(),
  {
    installSkills: !args.has("--no-skills"),
    initOpenSpec: !args.has("--no-openspec"),
    installOperatorHelper: !args.has("--no-operator-helper"),
  },
  { onStep: (label, index, total) => console.log(`[${index}/${total}] ${label}`) },
)
console.log(`\n${formatResults(results)}`)
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0
