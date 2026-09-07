# create-agent-bundle

Scaffold a new [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle)
plugin project from a checked-in template: one `agent-bundle.config.ts`, the
entry-file conventions, a passing test, and a delivery gate, ready to run.

```sh
npm create agent-bundle@latest my-plugin
# or
npx create-agent-bundle my-plugin --template mcp-server
```

Until the first npm release is cut, install the scaffolder from the
[pkg.pr.new preview channel](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
instead of the npm registry:

```sh
npx https://pkg.pr.new/ScriptedAlchemy/agent-bundle/create-agent-bundle@<sha-or-pr> my-plugin
```

Interactive runs prompt for the project name, the template, and the host
targets. A run that names both a directory and a template is treated as
scripted and asks nothing — the remaining values fall back to their defaults.

## Options

| Flag | Meaning |
| --- | --- |
| `-d, --dir <dir>` | Project directory (also the first positional argument). `foo/bar` scaffolds into `foo/bar` and names the package `bar`; `@scope/name` keeps the scoped package name. |
| `-t, --template <name>` | `minimal`, `mcp-server`, or `cli-tool`. |
| `--targets <list>` | Comma-separated host targets: `portable`, `claude`, `codex`, `cursor`. Default: `portable,codex,claude`. |
| `--package-manager <name>` | `npm`, `pnpm`, `yarn`, or `bun`. Default: detected from the invoking client. |
| `--no-install` | Skip installing dependencies after scaffolding. |
| `--framework-version <spec>` | Pin the project's `agent-bundle` dependency to this spec (a version, a tarball path, or a URL). Runtime templates require the compiler version recorded by this scaffolder release. |
| `-h, --help` | Show usage. |

## Templates

| Template | What you get |
| --- | --- |
| `minimal` | A skills-only plugin: one `src/skills/<name>/SKILL.md` directory and nothing else. |
| `mcp-server` | A stdio MCP server from one `src/mcp/<server>/tools/<name>.tsx` route module plus one artifact script, with the framework test harness wired up. |
| `cli-tool` | An installable routed CLI from one `src/cli/<command>.ts` route module (generated executable, help, argv grammar, validation), a conventional `src/scripts/<name>.ts` artifact script, and a `src/index.ts` library export with declarations, with the framework test harness wired up. |

Every template ships a `check` script (validate + build + typecheck + tests)
and validates with zero diagnostics — including the `AB473x` migration
nudges, because the templates are written against the entry conventions from
the start.

The `mcp-server` and `cli-tool` templates also start with the consumer test
harness. `mcp-server` ships a route-unit pool (`agentBundleRstest()` from
`agent-bundle/rstest`, `renderRoute` and `expectDocument` from
`agent-bundle/test`) and a separate in-memory MCP projection pool; `cli-tool`
ships one projection pool at the `cli-dispatch` (`invokeCli`, `cliJson`) and
`script-dispatch` (`runScript`) levels. Each pool is labeled with the proof
level it carries and run by `check`. The `minimal` template compiles no route
modules, so it ships no harness pool that would pass without addressing
anything; its README documents the wiring to add with the first route.

## The framework dependency

Preview scaffolders pin `agent-bundle` and `@agent-bundle/runtime` to exact
[pkg.pr.new](https://pkg.pr.new) tarballs from one commit SHA. An npm release
instead records its compatible compiler and runtime versions as optional
peers in the packed `create-agent-bundle` manifest. The scaffolder pins those
two recorded versions independently — it never derives the runtime version
from the compiler version — and rejects a runtime-bearing scaffold whose
`--framework-version` does not match the recorded compiler. A local compiler
tarball selects the sibling runtime tarball with the recorded runtime version
and validates both package names and versions before writing the project.

## License

Apache License 2.0. The published tarball carries the repository
[LICENSE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/LICENSE) and
[NOTICE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/NOTICE).
