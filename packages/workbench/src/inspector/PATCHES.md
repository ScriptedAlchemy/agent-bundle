# Inspector local patches

The Inspector `2.2.0` snapshot currently has no local source patches.

The Rsbuild aliases and the compile-only adapter are outside `vendor/`, so the
allowlisted upstream files stay byte-identical. Any future vendor change must
be represented by a numbered `patches/*.patch` file and recorded by
`scripts/sync-inspector.mjs` in `UPSTREAM.json`.
