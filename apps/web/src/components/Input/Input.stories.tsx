import type { Meta, StoryObj } from '@storybook/react-vite';
import { SectionLabel } from '../SectionLabel';
import { Input } from './Input';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { defaultValue: 'Dusty', size: 'md', 'aria-label': 'Name' },
  argTypes: { size: { control: 'inline-radio', options: ['md', 'lg', 'display'] } },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const field = { display: 'flex', flexDirection: 'column', gap: 6, width: 484 } as const;

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={field}>
        <SectionLabel as="label" htmlFor="agent-name">
          Name
        </SectionLabel>
        <Input id="agent-name" defaultValue="Dusty" />
      </div>
      <div style={field}>
        <Input size="lg" aria-label="Invite by email" placeholder="name@company.com" />
      </div>
      <div style={{ ...field, width: 640, gap: 10 }}>
        <Input size="display" aria-label="Burrow name" defaultValue="Burrow HQ" />
      </div>
      <div style={field}>
        <Input aria-label="Invalid" defaultValue="not an email" invalid />
        <Input aria-label="Disabled" defaultValue="Disabled" disabled />
      </div>
    </div>
  ),
};
