# L7 — English docs for Workbench IA

## Pages changed

- `website/docs/en/guide/development/workbench.mdx` — rewrote the Workbench guide around
  Application, Trace, Problems, Advanced, route workspaces, deep links, and invocation APIs.
- `website/docs/en/guide/development/testing.mdx` — documented the new
  `inspectWorkbenchSurface()` application-tree return shape and removed page-name APIs.
- `website/docs/en/guide/development/evaluations.mdx` — moved Workbench eval instructions to
  Advanced → Evals → Runs / Compare.
- `website/docs/en/guide/development/index.mdx` — replaced the old page/playground inventory with
  the new four-area Workbench summary.
- `website/docs/en/guide/start/quick-start.mdx` — updated the interactive development overview to
  the Application tree, rendered results, Trace, Problems, and Advanced.
- `website/docs/en/guide/authoring/index.mdx` — moved route-contract inspection from the deleted
  Routes page to the selected route inspector.
- `website/docs/en/guide/authoring/hooks.mdx` — moved hook simulation to Application →
  Events / Hooks and documented host fixtures and projection details.
- `website/docs/en/guide/authoring/mcp.mdx` — moved task controls to Advanced → Protocol and App
  previews to MCP App leaves.
- `website/docs/en/guide/authoring/scripts-assets.mdx` — moved script execution from Playground to
  Application → Scripts.
- `website/docs/en/guide/authoring/skills.mdx` — moved rendered Skill inspection to Application →
  Skills and its inspector tabs.
- `website/docs/en/examples/audiobook-curator.mdx` — added the `search_audible` rendered-route
  development loop and deep link.
- `website/docs/en/examples/hooks-and-scripts.mdx` — rewrote the walkthrough for event/script
  leaves, Trace, Problems, and Advanced.
- `website/docs/en/examples/mcp-app.mdx` — rewrote the walkthrough for Application leaves and
  Advanced protocol, artifact, and eval views.
- `website/docs/en/examples/skills-starter.mdx` — rewrote the walkthrough for Skill leaves,
  Advanced artifact/evals, and Problems repair.
- `website/docs/en/index.mdx` — updated the home-page Workbench feature and development summary.
- `website/docs/en/reference/cli.mdx` — replaced the deleted MCP-page reference with the App
  workspace.
- `website/docs/en/reference/configuration.mdx` — renamed the contract-gated Workbench destination
  to the route workspace.
- `website/docs/en/reference/limitations.mdx` — removed the deleted Playground product name from
  the pre-0.1 record warning.
- `website/docs/en/reference/runtime-environment.mdx` — moved hook simulation environment wording
  to the event route workspace.

## Verification and cross-lane notes

- No English page embeds a screenshot, so no image needs recapture.
- VERIFY: the URL examples and refresh-safe shell paths were checked against
  `packages/agent-bundle/src/dev/routes/application-node.ts`,
  `packages/agent-bundle/src/dev/workbench-shell-paths.ts`, and
  `packages/workbench/src/shell/workbench-location.ts`.
- VERIFY: the invocation envelope and `route.invocation` event were checked against
  `packages/agent-bundle/src/dev/routes/route-invocation.ts`. The route implementation and final
  AB8231–AB8235 assignments land in another lane.
- VERIFY: `docs/diagnostics.md` on this lane still gives AB8233–AB8235 their pre-#600 browser
  decoder meanings. The integration lane must take the other lane's diagnostic registration
  before treating the new Workbench guide's AB8231–AB8235 range as final.
- VERIFY: `packages/agent-bundle/src/test/workbench.ts` still exports `WorkbenchPageName`,
  `workbenchPageLabel`, and `pages` on this lane. The testing docs intentionally follow the L10
  cross-lane contract: `{ application, routes, lifecycles, counts, advanced }`.
- TraceDecay MCP discovery failed and its CLI daemon socket was unavailable. The bounded
  English-doc search and review therefore used workspace search directly.
- Screenshots to recapture: none.
- Proposed changeset: none; this lane changes only the private documentation site.
- `pnpm build` passed before and after the edits.
- `pnpm docs:site:build` reached the expected locale-drift failure: the English Workbench page
  differs from untranslated Chinese in diagnostic codes, fence count, heading count, and table
  row count.
- Running the remaining documentation stages without locale drift found one cross-lane failure:
  diagnostics coverage rejects `AB8231` until the invocation lane registers AB8231–AB8235.
- With locale drift and that pending diagnostic registration isolated, the Rspress build passed
  and the link checker reported `0 broken links / 28122 anchors checked`.

## Open risks

- The English/Chinese language-parity gate is expected to fail until L8 mirrors these changes.
- Invocation diagnostics and the public Workbench test surface cannot be source-verified on this
  isolated lane until L1/L10 integrate.
