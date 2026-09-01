interface AgentFlightManifest {
  readonly clientManifest: Readonly<Record<string, never>>;
  readonly moduleLoading: null;
  readonly serverConsumerModuleMap: null;
  readonly serverManifest: Readonly<Record<string, never>>;
}

const EMPTY_FLIGHT_MANIFEST: AgentFlightManifest = Object.freeze({
  clientManifest: Object.freeze({}),
  moduleLoading: null,
  serverConsumerModuleMap: null,
  serverManifest: Object.freeze({}),
});

export const ensureAgentFlightManifest = (): void => {
  const scope = globalThis as typeof globalThis & { __rspack_rsc_manifest__?: unknown };
  if (scope.__rspack_rsc_manifest__ !== undefined) return;
  scope.__rspack_rsc_manifest__ = EMPTY_FLIGHT_MANIFEST;
};
