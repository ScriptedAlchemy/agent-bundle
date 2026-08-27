import { Badge, Button, Card, Code, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMemo } from 'react';

import type { InspectorProtocolEntry } from './inspector-session-adapter-model.ts';

type SortDirection = 'oldest-first' | 'newest-first';

interface ProtocolUiState {
  readonly search: string;
  readonly visibleDirections: Readonly<Record<'client' | 'server', boolean>>;
}

interface ProtocolScreenWithoutReplayProps {
  readonly compact: boolean;
  readonly entries: readonly InspectorProtocolEntry[];
  readonly onClearAll: () => void;
  readonly onExport: () => void;
  readonly onSortChange: (direction: SortDirection) => void;
  readonly onToggleCompact: () => void;
  readonly onTogglePin: (id: string) => void;
  readonly onUiChange: (ui: ProtocolUiState) => void;
  readonly pinnedIds: ReadonlySet<string>;
  readonly sortDirection: SortDirection;
  readonly ui: ProtocolUiState;
}

const frameName = (entry: InspectorProtocolEntry): string =>
  entry.direction === 'response'
    ? `response:${String(entry.message.id)}`
    : `${entry.direction}:${String(entry.message.method)}`;

const matchesSearch = (entry: InspectorProtocolEntry, search: string): boolean =>
  search.length === 0 || JSON.stringify(entry.message).toLowerCase().includes(search.toLowerCase());

/**
 * The embedded Inspector exposes a raw transport timeline but no replay-capable invocation binding.
 * This narrow Protocol presentation retains every frame while intentionally
 * omitting the vendored Replay action, which has no supported implementation.
 */
export const ProtocolScreenWithoutReplay = ({
  compact,
  entries,
  onClearAll,
  onExport,
  onSortChange,
  onToggleCompact,
  onTogglePin,
  onUiChange,
  pinnedIds,
  sortDirection,
  ui,
}: ProtocolScreenWithoutReplayProps) => {
  const displayedEntries = useMemo(() => entries
    .filter((entry) => ui.visibleDirections[entry.origin] && matchesSearch(entry, ui.search))
    .sort((left, right) => sortDirection === 'oldest-first'
      ? left.sequence - right.sequence
      : right.sequence - left.sequence), [entries, sortDirection, ui.search, ui.visibleDirections]);

  return <section aria-label="Protocol inspector">
    <Group justify="space-between" mb="sm">
      <Title order={4}>Messages</Title>
      <Group gap="xs">
        <Button aria-label="History sort direction" onClick={() => onSortChange(sortDirection === 'oldest-first' ? 'newest-first' : 'oldest-first')} size="xs" variant="default">
          {sortDirection === 'oldest-first' ? 'Oldest first' : 'Newest first'}
        </Button>
        <Button onClick={onClearAll} size="xs" variant="default">Clear</Button>
        <Button disabled={displayedEntries.length === 0} onClick={onExport} size="xs" variant="default">Export</Button>
        <Button aria-pressed={compact} onClick={onToggleCompact} size="xs" variant="default">Compact</Button>
      </Group>
    </Group>
    <TextInput
      aria-label="Search protocol history"
      mb="md"
      onChange={(event) => onUiChange({ ...ui, search: event.currentTarget.value })}
      placeholder="Search raw JSON-RPC frames"
      value={ui.search}
    />
    {displayedEntries.length === 0 ? <Text c="dimmed">No request history</Text> : <Stack aria-label="Protocol history" gap="sm">
      {displayedEntries.map((entry) => <Card
        data-protocol-frame={frameName(entry)}
        data-protocol-sequence={entry.sequence}
        key={entry.id}
        padding={compact ? 'xs' : 'sm'}
        withBorder
      >
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <Text ff="monospace" size="xs">{entry.timestamp.toISOString()}</Text>
            <Badge variant="light">{entry.origin}</Badge>
            <Badge variant="outline">{entry.direction}</Badge>
            <Text ff="monospace" size="xs">#{entry.sequence}</Text>
          </Group>
          <Button aria-pressed={pinnedIds.has(entry.id)} onClick={() => onTogglePin(entry.id)} size="compact-xs" variant="subtle">
            {pinnedIds.has(entry.id) ? 'Unpin' : 'Pin'}
          </Button>
        </Group>
        <Code block>{JSON.stringify(entry.message)}</Code>
      </Card>)}
    </Stack>}
  </section>;
};
