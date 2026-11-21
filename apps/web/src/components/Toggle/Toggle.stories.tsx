import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SectionLabel } from '../SectionLabel';
import { TierRow } from './TierRow';
import { Toggle, ToggleRow } from './Toggle';

const meta = {
  title: 'Primitives/Toggle',
  component: Toggle,
  args: { 'aria-label': 'whombat/billing', defaultChecked: true, size: 'md' },
  argTypes: { size: { control: 'inline-radio', options: ['md', 'sm'] } },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <Toggle aria-label="md on" defaultChecked />
      <Toggle aria-label="md off" />
      <Toggle aria-label="sm on" size="sm" defaultChecked />
      <Toggle aria-label="sm off" size="sm" />
      <Toggle aria-label="locked" size="sm" disabled />
    </div>
  ),
};

const KEYS = [
  { k: 'read', t: 'Read your chats and branch rooms' },
  { k: 'branch', t: 'Write to feat/* branches' },
  { k: 'tests', t: 'Run tests and CI' },
  { k: 'pr', t: 'Open pull requests' },
  { k: 'merge', t: 'Merge into main', locked: 'people only' },
  { k: 'deploy', t: 'Deploy', locked: 'always asks a person' },
] as const;

/** A KEYS list of switches (Settings → Agent's rows), with two locked keys. */
export const KeysList: Story = {
  render: () => {
    const [on, setOn] = useState<Record<string, boolean>>({
      read: true,
      branch: true,
      tests: true,
      pr: false,
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 484 }}>
        <SectionLabel style={{ paddingBottom: 4 }}>Keys</SectionLabel>
        {KEYS.map((key) => (
          <ToggleRow
            key={key.k}
            label={key.t}
            checked={!!on[key.k]}
            onCheckedChange={(v) => setOn((s) => ({ ...s, [key.k]: v }))}
            locked={'locked' in key}
            note={'locked' in key ? key.locked : undefined}
          />
        ))}
      </div>
    );
  },
};

const TIERS = [
  { value: 'cannot', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'can', label: 'On' },
] as const;

/** The KEYS list since Merge and Deploy have three states (AP-609); Deploy with its no-workflow hint. */
export const KeysListWithTiers: Story = {
  render: () => {
    const [merge, setMerge] = useState<string>('ask');
    const [deploy, setDeploy] = useState<string>('cannot');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 484 }}>
        <SectionLabel style={{ paddingBottom: 4 }}>Keys</SectionLabel>
        {KEYS.filter((key) => !('locked' in key)).map((key) => (
          <ToggleRow key={key.k} label={key.t} checked={key.k !== 'pr'} />
        ))}
        <TierRow label="Merge" options={TIERS} value={merge} onChange={setMerge} />
        <TierRow
          label="Deploy"
          options={TIERS}
          value={deploy}
          onChange={setDeploy}
          hint="No deploy workflow is set up on this Whombat yet."
        />
      </div>
    );
  },
};
