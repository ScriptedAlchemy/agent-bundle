import {
  AppsScreen,
  LoggingScreen,
  NetworkScreen,
  PromptsScreen,
  ProtocolScreen,
  ResourcesScreen,
  ToolsScreen,
} from './inspector-closure-vendor.js';

/**
 * Compile-only adapter boundary for the phase-zero Inspector snapshot.
 *
 * It deliberately provides neither transport nor host state. W12-W14 own the
 * epoch-bound transport and the production theme adapter; vendor files remain
 * byte-identical upstream source.
 */
export const inspectorClosure = {
  AppsScreen,
  LoggingScreen,
  NetworkScreen,
  PromptsScreen,
  ProtocolScreen,
  ResourcesScreen,
  ToolsScreen,
} as const;
