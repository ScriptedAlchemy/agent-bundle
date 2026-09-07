import { z } from 'zod';

export const serviceSchema = z.enum(['compiler', 'payments-api']).describe('The example service to inspect.');

export const serviceStatusSchema = z.object({
  checks: z.array(z.object({ label: z.string(), status: z.enum(['passing', 'failing']) })),
  service: serviceSchema,
  status: z.enum(['healthy', 'degraded']),
  summary: z.string(),
});

export type Service = z.infer<typeof serviceSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/** The checked-in `evals/fixtures/status/result.json` must equal this record exactly. */
export const healthyCompilerStatus: ServiceStatus = {
  checks: [
    { label: 'Availability', status: 'passing' },
    { label: 'Build queue', status: 'passing' },
  ],
  service: 'compiler',
  status: 'healthy',
  summary: 'Compiler service is ready for release.',
};

const catalog: Readonly<Record<Service, ServiceStatus>> = {
  compiler: healthyCompilerStatus,
  'payments-api': {
    checks: [
      { label: 'Availability', status: 'passing' },
      { label: 'P95 latency', status: 'failing' },
    ],
    service: 'payments-api',
    status: 'degraded',
    summary: 'Payment latency is above the release threshold.',
  },
};

/** The health record of one example service; `payments-api` is deliberately degraded. */
export const serviceStatus = (service: Service): ServiceStatus => catalog[service];
