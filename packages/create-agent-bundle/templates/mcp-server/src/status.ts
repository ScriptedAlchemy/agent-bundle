/** Domain logic shared by the MCP server, the artifact script, and the tests. */

export interface StatusReport {
  readonly service: string;
  readonly status: 'healthy' | 'unknown';
  readonly summary: string;
}

const knownServices: readonly string[] = ['docs', 'api'];

export const reportStatus = (service: string): StatusReport => {
  if (!knownServices.includes(service)) {
    return { service, status: 'unknown', summary: `${service} is not a known service.` };
  }
  return { service, status: 'healthy', summary: `${service} is ready.` };
};
