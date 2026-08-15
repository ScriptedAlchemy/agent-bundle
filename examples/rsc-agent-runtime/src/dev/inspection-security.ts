const diagnosticPreviewBytes = 16 * 1024;

const sensitiveKey = /(?:api[-_]?key|authorization|bearer|credential|cookie|password|secret|token)/iu;
const sensitiveLabel = /((?:api[-_]?key|authorization|credential|cookie|password|secret|token)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu;
const providerCredentialSources = Object.freeze([
  String.raw`\bsk-(?:proj-|ant-|live-)?[a-z0-9_-]{16,}\b`,
  String.raw`\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|akia[a-z0-9]{16})\b`,
]);
const providerCredentialValues = Object.freeze(providerCredentialSources.map((source) => new RegExp(source, 'iu')));
const providerCredentialDiagnostics = Object.freeze(providerCredentialSources.map((source) => new RegExp(source, 'giu')));
const credentialAssignment = /(?:api[-_]?key|authorization|credential|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/iu;
const bearerCredential = /\bbearer\s+[^\s,;]+/iu;

export const isInspectionSensitiveKey = (key: string): boolean => sensitiveKey.test(key);

export const hasInspectionCredential = (value: string): boolean =>
  credentialAssignment.test(value)
  || bearerCredential.test(value)
  || providerCredentialValues.some((pattern) => pattern.test(value));

export const redactInspectionDiagnostics = (value: string): string => {
  let redacted = value.slice(0, diagnosticPreviewBytes).replace(sensitiveLabel, '$1[REDACTED]');
  for (const pattern of providerCredentialDiagnostics) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted;
};
