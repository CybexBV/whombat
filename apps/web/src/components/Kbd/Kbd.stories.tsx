import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../Icon';
import { formatShortcut, Kbd } from './Kbd';

const meta = {
  title: 'Primitives/Kbd',
  component: Kbd,
  args: { children: '⌘K' },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The sidebar search button with its shortcut hint (label adapts to the platform). */
export const SearchButton: Story = {
  render: () => (
    <div style={{ width: 232, background: 'var(--side)', padding: '12px 0' }}>
      <button
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: 'calc(100% - 8px)',
          margin: '0 4px',
          padding: '10px 12px',
          borderRadius: 12,
          border: '1px solid var(--line)',
          background: 'var(--sf)',
          color: 'var(--mut)',
          fontSize: 14.5,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Icon name="search" size={16} />
        <span style={{ flex: 1 }}>Search everything</span>
        <Kbd>{formatShortcut('k')}</Kbd>
      </button>
    </div>
  ),
};
