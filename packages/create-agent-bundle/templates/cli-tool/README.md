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
```

## Layout

- `agent-bundle.config.ts` — the one typed config; the CLI is also declared
  as a script so it ships inside every host artifact.
- `src/cli.ts` — the whole CLI entry: export `main`, the framework generates
  the process envelope and the executable bundle.
- `src/index.ts` — the library export (`dist/index.js` + `dist/index.d.ts`).
- `tests/` — run with `npm run test`.

## The agent-bundle dependency

agent-bundle has no npm release yet; this project pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball of it. To move to a newer
preview (or a real release once one exists), change the `agent-bundle` entry
in `devDependencies` — see
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
