---
"agent-bundle": minor
---

Judge `AB6005` from compile evidence only and remove the emitted-JavaScript import walk from `build`, `validate`, and the package build, including its `Generated JavaScript import from …` findings; rederive `AB7014` from packed declaration references, consumer install scripts, prebuilt `runtimeDependencies` declared with `definePrebuilt`, and the framework process-dependency record, report bundled dependencies with the `dist` bundles that inlined them, stop reading `require`/`createRequire`/`import.meta.resolve` literals, `bin`-command strings, `#subpath` imports, inline `node -e` programs, and packed files install scripts run, remove the computed-load withhold, and limit `AB7015` optional-dependency escalation to command-position `bin` commands, `node_modules/<name>/` files, and bare preloads. (#TBD)
