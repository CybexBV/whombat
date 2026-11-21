import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from './Icon';
import { type IconName, iconSlots } from './icons';

const meta = {
  title: 'Primitives/Icon',
  component: Icon,
  args: { name: 'search', size: 16 },
  argTypes: {
    name: { control: 'select', options: Object.keys(iconSlots) },
    size: { control: { type: 'range', min: 12, max: 24, step: 1 } },
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every named slot at 16 and 18px, 1.75px stroke. */
export const Slots: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
      {(Object.keys(iconSlots) as IconName[]).map((name) => (
        <div
          key={name}
          style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink2)', fontSize: 13.5 }}
        >
          <Icon name={name} size={16} />
          <Icon name={name} size={18} />
          <span style={{ font: 'var(--type-mono-meta-small)', color: 'var(--mut)' }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};

/** Sidebar nav rows with icons in the 18px glyph slot. */
export const SidebarNav: Story = {
  render: () => (
    <div style={{ width: 232, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {(
        [
          ['agents', 'Agents', '6'],
          ['canvases', 'Canvases', '4'],
          ['auditLog', 'Audit log', ''],
        ] as const
      ).map(([icon, label, meta]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            borderRadius: 10,
            fontSize: 14.5,
            fontWeight: 500,
          }}
        >
          <span style={{ width: 18, display: 'flex', justifyContent: 'center', color: 'var(--mut)' }}>
            <Icon name={icon} size={16} />
          </span>
          <span style={{ flex: 1 }}>{label}</span>
          <span style={{ font: 'var(--type-mono-badge)', color: 'var(--mut)' }}>{meta}</span>
        </div>
      ))}
    </div>
  ),
};
