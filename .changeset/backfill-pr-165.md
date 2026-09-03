---
"agent-bundle": patch
---

Static route config extraction rejects non-finite numeric literals such as `1e999` with the `AB4806` dynamic-config diagnostic instead of digesting them as `null`, preserves a literal `__proto__` key as an own property, and route discovery now includes `.jsx` script modules, which were previously skipped silently. (#165)
