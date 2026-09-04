---
"@agent-bundle/runtime": patch
---

Validate runtime operation inputs, state conformance, and the notice inbox route with `zod` 4.5.4 instead of 4.4.3 (fixes an upstream default-factory misfire during cycle walks); `@agent-bundle/runtime` installs pull the updated dependency. (#304)
