---
"agent-bundle": patch
---

Let a rendered Skill (`src/skills/<name>/SKILL.tsx`) import `agent-bundle/meta` and evaluate independently of the process's `react` resolution. The skill loader now aliases `agent-bundle/meta` to the same generated identity module the compiler stamps into every built surface — `{ name, packageName, packageVersion, version }` derived from `plugin.name`, `package.json`, and the resolved plugin version — under `validate`, `build`, `inspect`, dev, the Workbench's source Skill documents, and `inspectWorkbenchSurface`, instead of failing with `AB3003` wrapping `AB4760`. The skill's JSX compiles against the loader's own element factory rather than the project's `react/jsx-runtime`, so `inspectWorkbenchSurface` no longer fails with `AB3005` (`recentlyCreatedOwnerStacks`) on a project with a rendered skill when the test runs under the `react-server` condition the `agentBundleRstest()` route-unit pool sets. Fixes #440 and #441 (#PR)
