# my-agent-plugin

A stdio MCP server plugin built with [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle).
The server entry is the convention `src/mcp/status.ts`: it default-exports a
server factory, and the build wraps it in the framework stdio lifecycle shell
(console-to-stderr guard, signal handling, stdin-EOF exit, heartbeat) — no
hand-rolled bootstrap.

## Commands

```sh
npm run dev        # local workbench with live rebuilds
npm run build      # write host artifacts to artifact/
npm run check      # validate + build + typecheck + test

# after a build: run, list, or invoke the server from the artifact
npx agent-bundle mcp run --server status --target portable --artifact artifact
npx agent-bundle mcp list --server status --target portable --artifact artifact
```

## Layout

- `agent-bundle.config.ts` — declares the `status` server and one script.
- `src/mcp/status.ts` — the conventional stdio entry (a factory export is the
  whole file).
- `src/scripts/check-status.ts` — an artifact script; its `main` export gets
  the generated process envelope.
- `src/status.ts` — shared domain logic, covered by `tests/`.

## The agent-bundle dependency

agent-bundle has no npm release yet; this project pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball of it. To move to a newer
preview (or a real release once one exists), change the `agent-bundle` entry
in `devDependencies` — see
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
