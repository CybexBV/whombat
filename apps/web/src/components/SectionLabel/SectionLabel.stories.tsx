import type { Meta, StoryObj } from '@storybook/react-vite';
import { SectionLabel } from './SectionLabel';

const meta = {
  title: 'Primitives/SectionLabel',
  component: SectionLabel,
  args: { children: 'PLAN · 4 STEPS', size: 'md', tone: 'mut' },
  argTypes: {
    size: { control: 'inline-radio', options: ['md', 'sm'] },
    tone: { control: 'inline-radio', options: ['mut', 'warn', 'ok', 'bad', 'brand', 'ink'] },
  },
} satisfies Meta<typeof SectionLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionLabel size="sm">CHANNELS</SectionLabel>
      <SectionLabel>KEYS</SectionLabel>
      <SectionLabel tone="warn">NEO IS ASKING</SectionLabel>
      <SectionLabel tone="ok">DEPLOYED</SectionLabel>
      <SectionLabel tone="bad">REVIEW · 2 CHANGES REQUESTED</SectionLabel>
      <SectionLabel as="h3">RIGHT NOW</SectionLabel>
    </div>
  ),
};
