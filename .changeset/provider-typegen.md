---
"@agent-bundle/runtime": patch
"agent-bundle": patch
---

Type project-defined context providers without a compiler change per
provider. `AgentProviderValues` is now an augmentable interface (string index
of `unknown` plus the optional framework-owned `processLifetime`, exported as
`AgentProcessLifetime`), and the generated `.agent-bundle/routes.d.ts`
declares `AgentBundleProviders` / `ProviderKey` / `ProviderValue<Key>` from
each conventional `src/providers/*` factory's awaited return type and augments
`@agent-bundle/runtime` so `(await agent()).providers.<key>` observes that
type. Provider-free graphs emit no augmentation; a graph with providers but no
executable routes keeps the declaration file.
