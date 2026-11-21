import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tag } from './Tag';

const meta = {
  title: 'Primitives/Tag',
  component: Tag,
  args: { children: 'Operator', variant: 'soft' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['soft', 'outline'] },
    tone: { control: 'inline-radio', options: [undefined, 'ok', 'warn', 'bad', 'mut', 'brand', 'ink'] },
  },
} satisfies Meta<typeof Tag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AuditLog: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Neo</span>
        <Tag>Operator</Tag>
      </div>
      <Tag variant="outline" tone="warn">
        Waiting on a person
      </Tag>
      <Tag variant="outline" tone="bad">
        Blocked
      </Tag>
      <Tag variant="outline" tone="ok">
        Approved
      </Tag>
    </div>
  ),
};
