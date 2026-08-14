import { MantineProvider, Stack, Text, Title } from '@mantine/core';
import { createRoot } from 'react-dom/client';

import { inspectorClosure } from './inspector/adapter/closure-spike.ts';

const InspectorClosureSpike = () => (
  <MantineProvider>
    <Stack p="xl">
      <Title order={1}>Inspector closure spike</Title>
      <Text>{Object.keys(inspectorClosure).join(', ')}</Text>
    </Stack>
  </MantineProvider>
);

createRoot(document.getElementById('root')!).render(<InspectorClosureSpike />);
