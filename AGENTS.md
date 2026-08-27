# Repository guidance

## Workbench platform scope

- The developer Workbench is a desktop-only application.
- Design, implementation, and browser acceptance should target desktop viewports and desktop interaction patterns.
- Do not add mobile-specific layouts, responsive behavior, or mobile acceptance requirements unless the user explicitly requests them.
- A mobile-only layout defect is not a release blocker for this repository.

## Public examples

- Treat `examples/*` as user-facing products, not test fixtures.
- Use only public `agent-bundle` package exports and `workspace:*` dependencies.
- Validate examples at a 1440×900 desktop viewport; mobile support is not required.
- Never accept or capture a Workbench route while its loading state is still visible.
- Browser acceptance must cover populated state plus the documented stale-diagnostic and repair flow.
