export const healthyCompilerStatus = Object.freeze({
  checks: Object.freeze([
    Object.freeze({ label: 'Availability', status: 'passing' }),
    Object.freeze({ label: 'Build queue', status: 'passing' }),
  ]),
  service: 'compiler',
  status: 'healthy',
  summary: 'Compiler service is ready for release.',
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isHealthyCompilerFixture = (value: unknown): boolean => {
  if (
    !isRecord(value)
    || value.service !== healthyCompilerStatus.service
    || value.status !== healthyCompilerStatus.status
    || value.summary !== healthyCompilerStatus.summary
  ) {
    return false;
  }

  // Bind the property once: a narrowing on `value.checks` does not survive
  // into the `every` callback, so the guard and the indexing share one binding.
  const checks: unknown = value.checks;
  if (!Array.isArray(checks) || checks.length !== healthyCompilerStatus.checks.length) {
    return false;
  }

  return healthyCompilerStatus.checks.every((expected, index) => {
    const received: unknown = checks[index];
    return isRecord(received)
      && received.label === expected.label
      && received.status === expected.status;
  });
};
