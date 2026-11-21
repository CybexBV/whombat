import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../Icon';
import { Button, IconButton } from './Button';

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Add a server', variant: 'primary', size: 'xl' },
  argTypes: {
    variant: { control: 'inline-radio', options: ['primary', 'secondary', 'ghost', 'link'] },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const row = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } as const;
const col = { display: 'flex', flexDirection: 'column', gap: 18 } as const;

/** Every size in both main variants, labelled with the mock instance it reproduces. */
export const Sizes: Story = {
  render: () => (
    <div style={col}>
      <div style={row}>
        <Button variant="primary" size="xl">
          Add a server
        </Button>
        <Button variant="primary" size="xl" padX={20}>
          Approve in advance
        </Button>
        <Button variant="secondary" size="xl">
          Export CSV
        </Button>
        <Button variant="primary" size="xl" padY={12} padX={22}>
          Continue
        </Button>
      </div>
      <div style={row}>
        <Button variant="primary" size="lg">
          Message
        </Button>
        <Button variant="secondary" size="lg">
          Watch run
        </Button>
        <Button variant="secondary" size="lg">
          Configure
        </Button>
      </div>
      <div style={row}>
        <Button variant="primary" size="md">
          Approve
        </Button>
        <Button variant="secondary" size="md">
          Plan canvas
        </Button>
        <Button variant="secondary" size="md">
          Branch room
        </Button>
      </div>
      <div style={row}>
        <Button variant="secondary" size="sm">
          Review deploy
        </Button>
        <Button variant="secondary" size="sm">
          Open in search
        </Button>
        <Button variant="primary" size="xs">
          Send
        </Button>
      </div>
      <div style={row}>
        <Button variant="ghost" size="sm">
          Undo
        </Button>
        <Button variant="link">Full audit trail →</Button>
        <IconButton label="Close">
          <Icon name="close" />
        </IconButton>
      </div>
    </div>
  ),
};

/** Disabled: "Merge into main" before checks pass (sf2 fill, mut text, not-allowed cursor). */
export const Disabled: Story = {
  render: () => (
    <div style={{ ...col, width: 292 }}>
      <Button variant="primary" size="xl" padY={12} block disabled>
        Merge into main
      </Button>
      <div style={row}>
        <Button variant="secondary" size="md" disabled>
          Secondary
        </Button>
        <Button variant="ghost" size="md" disabled>
          Ghost
        </Button>
      </div>
    </div>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <div style={row}>
      <Button variant="secondary" size="md" iconStart={<Icon name="export" />}>
        Export CSV
      </Button>
      <Button variant="primary" size="md" iconEnd={<Icon name="forward" />}>
        Open plan canvas
      </Button>
    </div>
  ),
};
