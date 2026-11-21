import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SegmentedControl } from '../SegmentedControl';
import { Chip, RemovableChip } from './Chip';

const meta = {
  title: 'Primitives/Chip',
  component: Chip,
  args: { children: 'Code', count: 5, active: false },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const KINDS = [
  ['All', 14],
  ['Code', 5],
  ['Asks', 2],
  ['Keys', 2],
  ['Messages', 4],
  ['Blocked', 1],
] as const;

/** Audit log kind filters with counts; click to select. */
export const Filters: Story = {
  render: () => {
    const [kind, setKind] = useState('All');
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {KINDS.map(([k, n]) => (
          <Chip key={k} count={n} active={kind === k} onClick={() => setKind(k)}>
            {k}
          </Chip>
        ))}
      </div>
    );
  },
};

export const Removable: Story = {
  render: () => <RemovableChip removeLabel="Remove filter: Only Banjo">Only Banjo</RemovableChip>,
};

/**
 * The audit log filter bar exactly as in the reference (1040px column minus 36px padding each
 * side): segmented actor control on the left, kind chips on the right.
 */
export const AuditLogFilterBar: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => {
    const [actor, setActor] = useState<'Everyone' | 'People' | 'Agents'>('Everyone');
    const [kind, setKind] = useState('All');
    return (
      <div style={{ maxWidth: 1040, padding: '40px 36px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <SegmentedControl
              label="Actor"
              options={['Everyone', 'People', 'Agents'] as const}
              value={actor}
              onChange={setActor}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {KINDS.map(([k, n]) => (
              <Chip key={k} count={n} active={kind === k} onClick={() => setKind(k)}>
                {k}
              </Chip>
            ))}
          </div>
        </div>
      </div>
    );
  },
};
