/**
 * Browser-consumable contract surface for credential-shaped key detection
 * and free-text redaction used by the workbench log viewer.
 */
export { isCredentialKey, redactEvalCredentialText } from '../eval/credentials.ts';
