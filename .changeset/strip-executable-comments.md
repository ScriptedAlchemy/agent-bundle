---
'agent-bundle': patch
---

Strip comments from generated executables. `agent-bundle build` now runs the SWC minimizer with compression, mangling, and whitespace minification off, so bundled dependency documentation no longer ships while code stays readable and `/*! … */` license headers stay inline. Set `tools.rsbuild.output.minify` to `false` to keep every comment. (#PR)
