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
| `--targets <list>` | Comma-separated host targets: `portable`, `claude`, `codex`, `cursor`, `plugin`. Default: `portable,codex,claude`. |
| `--package-manager <name>` | `npm`, `pnpm`, `yarn`, or `bun`. Default: detected from the invoking client. |
| `--no-install` | Skip installing dependencies after scaffolding. |
| `--framework-version <spec>` | Pin the project's `agent-bundle` dependency to this spec (a version, a tarball path, or a URL). |
| `-h, --help` | Show usage. |

## Templates

| Template | What you get |
| --- | --- |
| `minimal` | A skills-only plugin: one `src/skills/<name>/SKILL.md` directory and nothing else. |
| `mcp-server` | A stdio MCP server from one `src/mcp/<server>/tools/<name>.tsx` route module plus one artifact script, with the framework test harness wired up. |
| `cli-tool` | An installable CLI through the `src/cli.ts` bin convention plus a `src/index.ts` library export with declarations. |

Every template ships a `check` script (validate + build + typecheck + tests)
and validates with zero diagnostics — including the `AB473x` migration
nudges, because the templates are written against the entry conventions from
the start.

The `mcp-server` template also starts with the consumer test harness: a
route-unit pool (`agentBundleRstest()` from `agent-bundle/rstest`, `renderRoute`
and `expectDocument` from `agent-bundle/test`) and a separate in-memory MCP
projection pool, each labeled with the proof level it carries and run by
`check`. The `minimal` and `cli-tool` templates compile no route modules, so
neither ships a harness pool that would pass without addressing anything; their
READMEs document the wiring to add with the first route.

## The framework dependency

Scaffolded projects pin `agent-bundle` to an exact
[pkg.pr.new](https://pkg.pr.new) preview tarball. Without
`--framework-version`, the pin is derived from this scaffolder's own preview
version: pkg.pr.new publishes every workspace package of one commit under the
same `-preview-<sha>` suffix, so the scaffolder and the framework it pins
always come from the same commit. A non-preview build of the scaffolder has
no derivable default (the `agent-bundle` name on npm currently belongs to an
unrelated project) and requires `--framework-version` explicitly.

## License

Apache License 2.0. The published tarball carries the repository
[LICENSE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/LICENSE) and
[NOTICE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/NOTICE).
