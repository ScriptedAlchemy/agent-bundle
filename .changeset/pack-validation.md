---
"agent-bundle": patch
"rsc-markdown-stream": patch
"create-agent-bundle": patch
---

Expose `./package.json` in every package's `exports` (`create-agent-bundle` gains an explicit `exports` map, closing its `dist/**` to deep imports); bound `agent-bundle`'s optional `@agent-bundle/runtime` peer to `>=0.0.0 <1` instead of `*`; drop `@modelcontextprotocol/server` from `agent-bundle`'s devDependencies (it stays a dependency) and the dead `!dist/workbench/**/*.map` entry from its `files`; gate releases on `attw --profile esm-only` for all three packed tarballs plus `scripts/check-declaration-imports.mjs`, which fails `pnpm lint:release` when a shipped `.d.ts` a consumer can reach imports a devDependency or an undeclared package. (#PR)
