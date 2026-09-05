---
"agent-bundle": patch
---

Ship type declarations that reference only packages a consumer can resolve: `dist/events/ipc.d.ts` no longer imports `zod` (`EventRuntimeAvailability` keeps the same `'available' | 'runtime-restarted' | 'runtime-unavailable'` union) and `dist/routes/input-schema.d.ts` no longer imports `typescript-5`, so a consumer type-checking with `skipLibCheck: false` never has to resolve an `agent-bundle` devDependency. The release gate enforces this from now on: `pnpm lint:release` runs `scripts/check-declaration-imports.mjs --strict`, so a devDependency or undeclared package imported from any packed `.d.ts` — internal declarations included, not only those reachable from `exports` — fails the gate instead of printing a warning.
