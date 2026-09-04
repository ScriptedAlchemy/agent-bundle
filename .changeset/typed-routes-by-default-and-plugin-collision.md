---
"agent-bundle": patch
"create-agent-bundle": patch
---

Make the generated `.agent-bundle/routes.d.ts` part of the TypeScript program by default and reject duplicated framework plugins. `create-agent-bundle` templates list `".agent-bundle/routes.d.ts"` in `tsconfig.json` `include` (the file stays gitignored), so `renderRoute` / `renderRouteEvents` type-check route ids, `input`, and `result` from the first build instead of degrading to `string` / `unknown` until the include is discovered in the docs; `agent-bundle validate` warns with `AB4834` when a project that compiles routes or providers has a root `tsconfig.json` whose program (resolved like `tsc -p`, including `extends` and one level of project `references`) leaves the published declaration out. `agent-bundle validate` (and every diagnostic-gated command) rejects a `tools.rsbuild.plugins` entry whose `name` matches a plugin the framework already registers (`rsbuild:react` from `@rsbuild/plugin-react`) with `AB4724`, because `plugins` arrays concatenate and Rsbuild never dedupes plugins by name, so the plugin would otherwise run twice. (#497)
