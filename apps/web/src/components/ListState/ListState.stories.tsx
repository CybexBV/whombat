import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyNote, ErrorNote, Skeleton, SkeletonRows } from './ListState';

const meta = {
  title: 'Primitives/ListState',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const frame = { maxWidth: 360, border: '1px solid var(--line)', borderRadius: 12 } as const;

/** Sidebar-style rows: no avatar, one line. */
export const SkeletonSidebarRows: Story = {
  render: () => (
    <div style={frame}>
      <SkeletonRows count={5} lines={1} />
    </div>
  ),
};

/** Roster/message-style rows: avatar + two lines. */
export const SkeletonListRows: Story = {
  render: () => (
    <div style={frame}>
      <SkeletonRows count={4} avatarSize={36} lines={2} />
    </div>
  ),
};

export const SingleBar: Story = {
  render: () => <Skeleton width={220} height={16} />,
};

/** One-line message + Retry, in the mocks' voice: short, plain, no exclamation marks. */
export const ErrorWithRetry: Story = {
  render: () => <ErrorNote message="Couldn’t load this. Try again in a moment." onRetry={() => {}} />,
};

export const ErrorNoRetry: Story = {
  render: () => <ErrorNote message="This request isn’t here any more, or it’s in a room you’re not in." />,
};

export const Empty: Story = {
  render: () => (
    <div style={frame}>
      <EmptyNote>Nothing here yet.</EmptyNote>
    </div>
  ),
};
