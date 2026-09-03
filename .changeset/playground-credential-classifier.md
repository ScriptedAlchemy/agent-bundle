---
"agent-bundle": patch
---

Route the Workbench's `dev.host.sync` project events to the browser, and give
the Playground trace store the shared credential classifier. `project-client`
registers one SSE listener per entry in its own event-type list, and that list
omitted `dev.host.sync`, so the events `host-install-manager` publishes never
reached the Workbench. `playground-store` also carried its own `sensitiveKey`
and provider-credential patterns instead of the `core/credentials` classifier
that documents itself as the single source for every redaction surface; it now
uses `isCredentialKey` and `containsProviderCredential`, which adds the provider
environment-variable patterns its local copy had omitted. Removes six more
modules nothing imported: `native-playground-catalog`, `playground-values`,
`playground-protocol`, `playground-durability`, `eval-service-types`, and
`run-store-types`.
