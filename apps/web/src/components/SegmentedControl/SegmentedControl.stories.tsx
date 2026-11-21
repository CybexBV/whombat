import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SegmentedControl } from './SegmentedControl';

const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl,
  args: {
    label: 'Actor',
    options: ['Everyone', 'People', 'Agents'],
    value: 'Everyone',
    onChange: () => {},
  },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AuditLogActors: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return <SegmentedControl {...args} value={value} onChange={setValue} />;
  },
};

export const SecondSelected: Story = {
  args: { value: 'People' },
};
