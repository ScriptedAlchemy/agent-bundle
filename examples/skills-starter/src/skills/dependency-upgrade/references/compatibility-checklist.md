# Compatibility checklist

Check the surfaces the upgrade affects. Reuse current evidence tied to the
candidate; identify absent release evidence without blocking a planning task.

- Runtime and package-manager support matrix is explicit.
- Direct, peer, optional, and transitive dependency effects are understood.
- Configuration defaults and removed/deprecated APIs are accounted for.
- Generated files and package exports remain deterministic.
- Relevant type checks and focused tests pass; verify builds and packed
  consumers when the upgrade affects emitted or published output.
- CI caches, lockfiles, SBOM, license, and provenance checks remain valid.
- Rollout ownership, telemetry, and rollback conditions are documented.
