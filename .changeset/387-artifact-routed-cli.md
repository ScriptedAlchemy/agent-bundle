---
"agent-bundle": minor
---

Emit the routed CLI (`src/cli/**`) into every host artifact as
`<target>/bin/<plugin-name>.mjs` (plus `bin/<plugin-name>-flight.mjs` when a
command renders), not only into the npm package build, so installed skills,
hooks, and script routes can run it with `node <plugin-root>/bin/<plugin-name>.mjs`.
Every built-in target publishes the new `cli` adapter capability that admits
the bin; `inspect` accounts for it as a `cli` component, `inspect --bundler`
and the artifact manifest list it, and artifact validation admits the `cliBin`
layout. A target without the capability omits the bin with `AB4765`; a
host-emitted file colliding with the bin path fails the build with `AB4766`.
Script routes reach the bin as their `../bin/<plugin-name>.mjs` sibling;
skills and hooks reach it through the plugin-root token. The package build's
`dist/bin/<plugin-name>.js` is unchanged. (#419)
