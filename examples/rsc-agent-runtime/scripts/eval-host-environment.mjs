const ordinarySessionKeys = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
  'SHELL',
];

const sensitiveEnvironmentKey = (key) =>
  /_API_KEY$/iu.test(key) ||
  /(?:^|_)(?:AUTH|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL|API_BASE|USE_BEDROCK|USE_FOUNDRY|USE_VERTEX)$/iu.test(key);

const ownString = (environment, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
};

/** Returns the sole child environment allowed for native-host evaluation. */
export const sanitizedHostEnvironment = (environment, owned = {}) => {
  const child = {};
  for (const key of ordinarySessionKeys) {
    if (sensitiveEnvironmentKey(key)) continue;
    const value = ownString(environment, key);
    if (value !== undefined) child[key] = value;
  }
  const ownedKeys = [
    ['AGENT_RUNTIME_HOOK_PROBE_FILE', owned.hookProbeFile],
    ['AGENT_RUNTIME_STATE_FILE', owned.stateFile],
    ['CODEX_HOME', owned.codexHome],
  ];
  for (const [key, value] of ownedKeys) {
    if (typeof value === 'string') child[key] = value;
  }
  return child;
};
