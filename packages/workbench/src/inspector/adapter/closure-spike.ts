import { AppsScreen } from '../vendor/clients/web/src/components/screens/AppsScreen/AppsScreen.tsx';
import { LoggingScreen } from '../vendor/clients/web/src/components/screens/LoggingScreen/LoggingScreen.tsx';
import { NetworkScreen } from '../vendor/clients/web/src/components/screens/NetworkScreen/NetworkScreen.tsx';
import { PromptsScreen } from '../vendor/clients/web/src/components/screens/PromptsScreen/PromptsScreen.tsx';
import { ProtocolScreen } from '../vendor/clients/web/src/components/screens/ProtocolScreen/ProtocolScreen.tsx';
import { ResourcesScreen } from '../vendor/clients/web/src/components/screens/ResourcesScreen/ResourcesScreen.tsx';
import { ToolsScreen } from '../vendor/clients/web/src/components/screens/ToolsScreen/ToolsScreen.tsx';

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
