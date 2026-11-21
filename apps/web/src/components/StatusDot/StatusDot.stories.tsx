import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusDot, StatusPill } from './StatusDot';

const meta = {
  title: 'Primitives/StatusDot',
  component: StatusDot,
  args: { status: 'working', size: 7 },
  argTypes: {
    status: { control: 'inline-radio', options: ['working', 'waiting', 'idle', 'online'] },
    tone: { control: 'inline-radio', options: [undefined, 'ok', 'warn', 'bad', 'mut', 'brand'] },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

const row = { display: 'flex', alignItems: 'center', gap: 14 } as const;

export const Dots: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={row}>
        <StatusDot status="working" />
        <StatusDot status="waiting" />
        <StatusDot status="idle" />
        <StatusDot status="online" size={9} />
      </div>
      <div style={row}>
        <StatusDot tone="warn" size={8} label="Changes requested" />
        <StatusDot tone="ok" size={8} label="Ready" />
        <StatusDot status="working" size={8} halo label="Live" />
      </div>
      <div style={{ ...row, padding: 12, background: 'var(--side)' }}>
        <span
          style={{
            position: 'relative',
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--tone-1)',
            color: 'var(--avatar-ink)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          MO
          <StatusDot
            status="online"
            size={9}
            ring="var(--side)"
            style={{ position: 'absolute', right: -1, bottom: -1 }}
          />
        </span>
      </div>
    </div>
  ),
};

export const Pills: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
      <StatusPill status="working">Working</StatusPill>
      <StatusPill status="waiting">Waiting</StatusPill>
      <StatusPill status="idle">Idle</StatusPill>
      <StatusPill tone="ok" variant="outline">
        Approved · PR #482
      </StatusPill>
      <StatusPill tone="warn" variant="outline">
        38 of 41 passing
      </StatusPill>
    </div>
  ),
};
