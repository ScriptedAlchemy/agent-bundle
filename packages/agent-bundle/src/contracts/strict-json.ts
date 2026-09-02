/**
 * Browser-consumable contract surface for strict JSON parsing and
 * snapshotting. The workbench must import from here, never from core/.
 */
export {
  hasOnlyOwnKeys,
  isPlainRecord,
  mapStrictJsonReason,
  parseJsonWithoutDuplicateKeys,
  snapshotStrictJsonValue,
  StrictJsonError,
  type JsonObject,
  type JsonValue,
  type SnapshotStrictJsonOptions,
  type StrictJsonReason,
} from '../core/strict-json.ts';
