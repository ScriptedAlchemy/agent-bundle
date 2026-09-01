---
'agent-bundle': patch
---

Fix generated executables crashing on any route authored with JSX.

Route entries were bundled without the React plugin, so Rslib lowered JSX to
the classic `React.createElement` factory — which no generated entry or Flight
worker has in scope. Every documented `.tsx` route (the contract's own example
shape) therefore failed at run time with `React is not defined`, while builds
and route-unit tests stayed green because the test transform selects the
automatic runtime. Route entries now build with the automatic JSX runtime, so
emitted modules import `react/jsx-runtime` themselves — under the
`react-server` condition for worker entries.

The defect survived because every build-level test authored its routes with an
explicit `createElement` import; the generated-route server test now authors
its tool route as JSX instead, which is what surfaced this from the new
`packed-stdio` proof level.
