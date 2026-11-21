import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconButton } from '../Button';
import { Icon } from '../Icon';
import { SectionLabel } from '../SectionLabel';
import { SidePane, type SidePaneWidth } from './SidePane';

const meta = {
  title: 'Primitives/SidePane',
  component: SidePane,
  parameters: { layout: 'fullscreen' },
  args: { width: 'thread', 'aria-label': 'Thread' },
  argTypes: {
    width: { control: 'inline-radio', options: ['thread', 'branch'] },
    surface: { control: 'inline-radio', options: ['bg', 'side'] },
  },
} satisfies Meta<typeof SidePane>;

export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ width, surface }: { width: SidePaneWidth; surface?: 'bg' | 'side' }) {
  return (
    <div style={{ position: 'relative', height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <div
        style={{
          width: 'var(--size-sidebar)',
          flex: 'none',
          background: 'var(--side)',
          borderRight: '1px solid var(--line)',
        }}
      />
      <main style={{ flex: 1, minWidth: 0, padding: '40px 36px' }}>
        <h1
          style={{
            margin: 0,
            font: 'var(--type-page-title)',
            letterSpacing: 'var(--type-page-title-tracking)',
          }}
        >
          Chat
        </h1>
        <p style={{ fontSize: 16, color: 'var(--ink2)' }}>
          Resize the viewport below 1240px: the pane stops pushing this column and overlays it with a shadow.
        </p>
      </main>
      <SidePane width={width} surface={surface} scroll aria-label="Thread">
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 16px 0' }}>
          <IconButton label="Close">
            <Icon name="close" />
          </IconButton>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '22px 28px' }}>
          <SectionLabel>THREAD</SectionLabel>
          <span style={{ fontSize: 15, lineHeight: 1.5 }}>
            Rounding VAT before formatting on feat/invoice-pdf.
          </span>
        </div>
      </SidePane>
    </div>
  );
}

export const Thread: Story = { render: () => <Frame width="thread" /> };
export const BranchRoom: Story = { render: () => <Frame width="branch" surface="side" /> };
