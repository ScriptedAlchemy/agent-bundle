# Inspector local patches

`001-rstest-inspector-tabs-import.patch` mechanically changes the retained
upstream `inspectorTabs.test.ts` import from `vitest` to `@rstest/core`. It
allows the exact upstream assertions to execute under this repository's Rstest
runner; no assertion or production-source content is changed.

All other allowlisted Inspector files remain byte-identical. Every vendor
change must be represented by a numbered `patches/*.patch` file and recorded
by `scripts/sync-inspector.mjs` in `UPSTREAM.json`.
