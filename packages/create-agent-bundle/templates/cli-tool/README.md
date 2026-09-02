# my-agent-plugin

A command-line tool and library built with
[agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle). There is no
second bundler config and no hand-written bin shim: the `src/cli.ts`
convention makes the executable `dist/bin/my-agent-plugin.js`, the
`src/index.ts` convention makes the library export with declarations, and one
`agent-bundle build` produces both alongside the host artifacts.

## Commands

```sh
npm run dev        # local workbench with live rebuilds
npm run build      # dist/ package build + host artifacts in artifact/
npm run check      # validate + build + typecheck + test

# after a build
node dist/bin/my-agent-plugin.js World

# after publishing/installing the package
npx my-agent-plugin-install install cursor
```

Installing the npm package does not mutate any host; run the generated
`my-agent-plugin-install install <host>` command explicitly.

## Layout

- `agent-bundle.config.ts` — the one typed config; the CLI is also declared
  as a script so it ships inside every host artifact.
- `src/cli.ts` — the whole CLI entry: export `main`, the framework generates
  the process envelope and the executable bundle.
- `src/index.ts` — the library export (`dist/index.js` + `dist/index.d.ts`).
- `tests/` — run with `npm run test`.

## Tests

`npm run test` runs ordinary module tests against `src/cli.ts` and
`src/index.ts`, and `npm run check` runs them after validate, build, and
typecheck.

This template deliberately ships **no** framework test pool. The framework's
consumer harness (`agent-bundle/rstest` + `agent-bundle/test`) addresses
*compiled routes*, and a CLI declared in `agent-bundle.config.ts` under
`scripts:` is a bundled entry, not a route: the compiler hands that module to
the script bundler, so this project compiles zero routes and there would be
nothing for `renderRoute` to render. A pool asserting that is vacuous, and a
vacuous pass is worse than no pool.

Adopt the harness when the project grows a routed surface:

- Plain `src/cli/**/*.ts` and rendered `src/cli/**/*.tsx` command routes make
  `invokeCli` / `cliJson` (the `cli-dispatch` level) meaningful — argv resolves
  and runs through the routed CLI's own shell. Rendered routes can additionally
  assert Markdown, explicit TTY, JSON, and NDJSON output; use `cliNdjson` for
  the ordered render-event stream. This level remains in-process, so use the
  packed CLI route suite for worker-thread, process-framing, executable, and
  chunk-by-chunk Flight streaming evidence.
  This template ships the conventional `src/cli.ts` entry (and a matching
  `scripts` entry in `agent-bundle.config.ts`). Adding command routes while
  that file remains triggers `AB4801`. Before creating `src/cli/**` modules,
  remove `src/cli.ts`, drop the `./src/cli.ts` script entry, and port any
  behavior into route modules — routed commands compile into
  `dist/bin/<plugin-name>.js` on their own. To keep the single-file CLI
  instead, set `routes: { cli: 'conventional' }` and do not add `src/cli/**`.
- `src/mcp/<server>/**` route modules make `renderRoute` (`route-unit`) and
  `invokeMcpTool` (`mcp-in-memory`) meaningful.

Then add a pool with the generated configuration and keep it out of the plain
run:

```ts
// rstest.route-unit.config.ts
import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

export default defineConfig(await agentBundleRstest());
```

```json
"test": "rstest tests --exclude \"tests/route-unit/**\"",
"test:routes": "rstest --config rstest.route-unit.config.ts"
```

Route rendering needs `react`, `zod`, and `@agent-bundle/runtime` (the same
packages the generated entries import) plus `@rstest/core`; install them
alongside the first route module. Routed commands export zod-based
`inputSchema` and `resultSchema`, so the scaffold cannot typecheck without
`zod` once `src/cli/**` modules exist. The `mcp-server` template ships this
wiring already.

## The agent-bundle dependency

agent-bundle has no npm release yet; this project pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball of it. To move to a newer
preview (or a real release once one exists), change the `agent-bundle` entry
in `devDependencies` — see
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
