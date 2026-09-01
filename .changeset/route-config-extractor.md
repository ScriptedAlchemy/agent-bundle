---
"agent-bundle": minor
---

Statically extract each route module's `config` export into the route-graph IR (#93, PR-2).

- Extraction is a real TS/TSX parse (TypeScript compiler, module never executed) of a single top-level `export const config = <expression>` declaration. The accepted grammar: object literals with identifier/string/numeric property names, array literals without spreads or holes, string and substitution-free template literals, numeric literals with optional unary `+`/`-`, `true`/`false`/`null`, and `as`/`satisfies`/non-null/parenthesis wrappers. The grammar is documented in `docs/diagnostics.md`.
- Rejections are named errors beside the compiled route, never silent choices: `AB4805` for a rejected declaration shape (`let`/`var`, destructuring, indirect `export { config }`, function/class, missing initializer, non-object value) and `AB4806` for a dynamic initializer, naming the offending construct and position. The route compiles with the shared empty config in both cases; a module without a config export compiles silently.
- The graph digest now covers extracted configs, and `agent-bundle inspect --routes` surfaces them per route. Still consumer-invisible: no public authoring surface changes.
