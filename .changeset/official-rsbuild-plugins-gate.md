---
'agent-bundle': patch
---

Document the framework-owned Rsbuild plugin set (`@rsbuild/plugin-react`, `rsbuild:react`) and the official plugins a project may add through `tools.rsbuild.plugins` in the configuration reference; `packages/agent-bundle/src/build/framework-plugins.ts` exports that set for the plugin-collision diagnostic and a unit test derives it from the synthesized configs. Remove the standalone `lint:package` script and its CI step: publint already runs inside every publishable package's `rslib build` through `rsbuild-plugin-publint` at `throwOn: 'warning'`, so `lint:release` is now only `attw --pack --profile esm-only`. (#509)
