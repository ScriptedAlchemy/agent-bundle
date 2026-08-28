const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];

export interface HttpSecurityConfig {
  allowedHosts: string[];
  allowedOrigins: string[];
}

const valuesFromEnvironment = (value: string | undefined, name: string): string[] => {
  const values = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '') ?? [];

  if (values.includes('*')) {
    throw new Error(`${name} must not include a wildcard`);
  }

  return values;
};

const normalizeHostname = (value: string, name: string): string => {
  try {
    const hostname = new URL(`http://${value}`).hostname;
    if (hostname !== value.toLowerCase()) {
      throw new Error('hostnames must not include a port');
    }

    return hostname;
  } catch {
    throw new Error(`${name} contains an invalid hostname: ${value}`);
  }
};

const normalizeOrigin = (value: string, name: string): string => {
  try {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) {
      throw new Error('origins must be exact HTTP(S) origins');
    }

    return origin.origin;
  } catch {
    throw new Error(`${name} contains an invalid origin: ${value}`);
  }
};

const sameHttpOrigin = (hostHeader: string | undefined): string | undefined => {
  if (hostHeader === undefined) {
    return undefined;
  }

  try {
    return new URL(`http://${hostHeader}`).origin;
  } catch {
    return undefined;
  }
};

export const resolveHttpSecurityConfig = (environment: NodeJS.ProcessEnv = process.env): HttpSecurityConfig => ({
  allowedHosts: [
    ...new Set([
      ...loopbackHosts,
      ...valuesFromEnvironment(environment.AGENT_RUNTIME_ALLOWED_HOSTS, 'AGENT_RUNTIME_ALLOWED_HOSTS').map((value) =>
        normalizeHostname(value, 'AGENT_RUNTIME_ALLOWED_HOSTS'),
      ),
    ]),
  ],
  allowedOrigins: [
    ...new Set(
      valuesFromEnvironment(environment.AGENT_RUNTIME_ALLOWED_ORIGINS, 'AGENT_RUNTIME_ALLOWED_ORIGINS').map((value) =>
        normalizeOrigin(value, 'AGENT_RUNTIME_ALLOWED_ORIGINS'),
      ),
    ),
  ],
});

export const allowsOrigin = (
  config: HttpSecurityConfig,
  hostHeader: string | undefined,
  originHeader: string | undefined,
): boolean =>
  originHeader === undefined ||
  originHeader === sameHttpOrigin(hostHeader) ||
  config.allowedOrigins.includes(originHeader);
