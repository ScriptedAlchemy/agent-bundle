---
"agent-bundle": minor
---

Explain host component selection in `inspect`. Every inspection plan now
lists `selected` components beside `skipped`, and each component that needs a
host capability carries that target's own four-state judgment as
`capability` — `supported` with pinned evidence for emitted surfaces, or
`degraded`/`unavailable`/`prohibited` with the host's reason for omissions —
so `inspect --json` explains why a surface is absent from a bundle in the
host's words. An adapter that publishes no row for a needed capability reads
as an honest `unavailable`. Human `inspect` output prints one accounting line
per target followed by each omission and its reason.
