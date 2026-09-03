---
"agent-bundle": minor
---

Emit the routed CLI (`src/cli/**`) into host artifacts, not only the npm
package build. Every target whose adapter publishes the new `cli` capability
(all built-in targets: `claude`, `codex`, `cursor`, `portable`, `plugin`)
now receives `bin/<plugin-name>.mjs` — the same compiled command graph as
`dist/bin/<plugin-name>.js`, run as `node <plugin-root>/bin/<plugin-name>.mjs`
— plus `bin/<plugin-name>-flight.mjs` when any command renders, so installed
skills, hooks, and script routes can invoke the CLI without a separate npm
install. Script routes reach it as the `../bin/<plugin-name>.mjs` sibling of
their own `import.meta.url`; skills and hooks reach it through the plugin-root
token. The artifact manifest, validation (`cliBin` layout), `inspect`
component accounting (`cli` kind), and `inspect --bundler` all know the new
`bin/` directory. A target without the capability omits the bin and reports
`AB4765`; a host-emitted file colliding with the bin path is `AB4766`. The
package build's own bin emission is unchanged.
