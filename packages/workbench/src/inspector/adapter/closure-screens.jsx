import { lazy } from 'react';

const screen = (load, name) => lazy(async () => ({ default: (await load())[name] }));

export const AppsScreen = screen(() => import('../vendor/clients/web/src/components/screens/AppsScreen/AppsScreen.tsx'), 'AppsScreen');
export const LoggingScreen = screen(() => import('../vendor/clients/web/src/components/screens/LoggingScreen/LoggingScreen.tsx'), 'LoggingScreen');
export const NetworkScreen = screen(() => import('../vendor/clients/web/src/components/screens/NetworkScreen/NetworkScreen.tsx'), 'NetworkScreen');
export const PromptsScreen = screen(() => import('../vendor/clients/web/src/components/screens/PromptsScreen/PromptsScreen.tsx'), 'PromptsScreen');
export const ProtocolScreen = screen(() => import('../vendor/clients/web/src/components/screens/ProtocolScreen/ProtocolScreen.tsx'), 'ProtocolScreen');
export const ResourcesScreen = screen(() => import('../vendor/clients/web/src/components/screens/ResourcesScreen/ResourcesScreen.tsx'), 'ResourcesScreen');
export const ToolsScreen = screen(() => import('../vendor/clients/web/src/components/screens/ToolsScreen/ToolsScreen.tsx'), 'ToolsScreen');
