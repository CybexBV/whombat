import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DeviceActionChoice, DeviceSkillCard as DeviceSkillCardData } from '@whombat/core';
import { useState } from 'react';
import { DeviceSkillCard, initialChoices } from './DeviceSkillCard';

/** The heat pump of mock 3 (one-whombat-shell.md AP-1274). */
const HEAT_PUMP: DeviceSkillCardData = {
  kind: 'device_skill',
  proposalId: 'dvp_heat-pump' as DeviceSkillCardData['proposalId'],
  name: 'Daikin Altherma heat pump',
  model: 'Altherma 3 H HT',
  readings: [
    { key: 'room', label: 'Room', value: '21.0', unit: '°C' },
    { key: 'water', label: 'Water to radiators', value: '34', unit: '°C' },
    { key: 'hot_water', label: 'Hot water', value: '48', unit: '°C' },
    { key: 'outside', label: 'Outside', value: '9', unit: '°C' },
    { key: 'power', label: 'Using', value: '1.2', unit: 'kW' },
    { key: 'mode', label: 'Mode', value: 'Heating' },
  ],
  moreReadings: 3,
  actions: [
    {
      key: 'room_temperature',
      label: 'Room temperature',
      description: 'Sets the room temperature the heat pump aims for.',
      proposed: { tier: 'can', limits: { min: 16, max: 24 } },
      valueType: 'number',
      min: 12,
      max: 28,
      unit: '°C',
    },
    {
      key: 'hot_water_boost',
      label: 'Hot water boost',
      description: 'On or off',
      proposed: { tier: 'ask' },
      valueType: 'boolean',
    },
    {
      key: 'heating_curve',
      label: 'Heating curve',
      description: 'The installer’s setting, change with care',
      proposed: { tier: 'off' },
      valueType: 'number',
      min: 0.2,
      max: 2,
      sensitive: true,
    },
  ],
  testedAt: '2026-09-23T11:39:00.000Z',
  status: 'proposed',
};

function Card({ card }: { card: DeviceSkillCardData }) {
  const [choices, setChoices] = useState<Record<string, DeviceActionChoice>>(() => initialChoices(card));
  return (
    <div style={{ maxWidth: 720 }}>
      <DeviceSkillCard
        card={card}
        choices={choices}
        onChoice={(key, choice) => setChoices((c) => ({ ...c, [key]: choice }))}
        onSwitchOn={() => console.info('switch on', choices)}
        onDecline={() => console.info('not now')}
      />
    </div>
  );
}

const meta = {
  title: 'Cards/Device skill',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Proposed (mock 3): the tested readings, Off · Ask me · Allowed with limits, Switch on. */
export const Proposed: Story = { args: { card: HEAT_PUMP } };

/** Switched on: your choices as they were sent. */
export const SwitchedOn: Story = {
  args: {
    card: {
      ...HEAT_PUMP,
      status: 'on',
      connectionId: 'con_heat-pump',
      decided: {
        room_temperature: { tier: 'can', limits: { min: 16, max: 24 } },
        hot_water_boost: { tier: 'can' },
        heating_curve: { tier: 'off' },
      },
    },
  },
};

/** Not now: nothing was made. */
export const Declined: Story = { args: { card: { ...HEAT_PUMP, status: 'declined' } } };
