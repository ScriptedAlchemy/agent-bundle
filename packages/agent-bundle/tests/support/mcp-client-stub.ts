/**
 * Default MCP client catalog responses shared by the session-service suites.
 *
 * Every catalog method answers empty so a test only has to state the calls it
 * actually exercises. Spread it where the defaults belong: later keys win, so
 * an override placed after the spread replaces the default.
 */
export const mcpCatalogStub = () => ({
  getPrompt: async () => ({ messages: [] }),
  getServerCapabilities: () => undefined,
  getServerVersion: () => undefined,
  listPrompts: async () => ({ prompts: [] }),
  listResources: async () => ({ resources: [] }),
  listResourceTemplates: async () => ({ resourceTemplates: [] }),
  listTools: async () => ({ tools: [] }),
  readResource: async () => ({ contents: [] }),
});

/** Inert stdio transport for sessions whose transport behaviour is not under test. */
export const stdioTransportStub = () => ({
  close: async () => undefined,
  send: async () => undefined,
  start: async () => undefined,
  stderr: null,
});
