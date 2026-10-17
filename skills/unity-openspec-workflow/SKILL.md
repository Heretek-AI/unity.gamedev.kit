---
name: unity-openspec-workflow
description: Spec-driven Unity game development. Use when planning, building or verifying a Unity feature with OpenSpec, the AnkleBreaker Unity MCP tools and the Unity/gamedev skill packs.
---

# Unity + OpenSpec game development workflow

## 1. Discover and specify (plan agent)

1. Load `grill-me` or `write-a-prd` (from `mattpocock/skills`) and interview the user about mechanics, controls, camera, physics, UI and multiplayer needs.
2. Run `/opsx-propose <feature-name>`, or create `openspec/changes/<feature-name>/` with `proposal.md`, `specs/`, `design.md` and `tasks.md`.
3. The plan agent may write to `openspec/`, `docs/` and `AGENTS.md`, and nothing else.

## 2. Bind the editor and pick skills (build agent)

1. Call `unity_list_instances`, then `unity_select_instance` with the project name or port. Ports change when the editor restarts, so discover again after a restart.
2. Load the domain skills the task needs with the `skill` tool, for example C# scripting, physics, animation, UI Toolkit, URP post-processing, multiplayer services or `tdd`. Use `find-skills` when nothing installed fits.

## 3. Implement and verify

1. Write C# under `Assets/` or `Packages/` with the file tools. Change GameObjects, prefabs, ScriptableObjects and scenes through `unity_*` MCP tools; use `unity_list_advanced_tools` for Shader Graph, NavMesh, terrain, profiling and multiplayer tools.
2. Do not hand-edit `.unity`, `.prefab` or `.asset` YAML when an MCP tool can make the change. Never write into `Library/`, `Temp/`, `Obj/`, `Logs/` or `UserSettings/`.
3. Check the Unity console for compiler errors, run EditMode and PlayMode tests until they pass, then run `/opsx-verify` before `/opsx-archive`.
