---
"agent-bundle": patch
"@agent-bundle/runtime": patch
"create-agent-bundle": patch
---

Build on Rslib 1.0 and Rsbuild 2.2 so a project installs one Rspack engine and one native
binding instead of two; `create-agent-bundle` templates pin `@rstest/core` 0.11.12. Plugin
builds stay self-contained (`output.autoExternal: false`, Node builtins the only externals) and
keep `new URL(…, import.meta.url)` and `new Worker(new URL(…))` expressions verbatim.
`agent-bundle inspect --bundler` lowers in production mode regardless of `NODE_ENV` and shows the
new `bundlerChain` invariant beside `tools.rspack`. Published `.d.ts` files (`agent-bundle`,
`@agent-bundle/runtime`) now import their siblings with `.js` specifiers; every `exports` entry
resolves as before. (#575)
