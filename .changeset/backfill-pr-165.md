---
"agent-bundle": patch
---

Reject non-finite numeric literals such as `1e999` in a route `export const config` with the `AB4806` dynamic-config diagnostic instead of digesting them as `null`, keep a literal `__proto__` config key as an own property, and discover `.jsx` modules under `src/scripts/` as script routes instead of skipping them silently. (#165)
