/**
 * Browser-consumable contract surface for deep freezing. The workbench must
 * import from here, never from core/.
 */
export { deepFreeze } from '../core/freeze.ts';
