import type { Meta, StoryObj } from '@storybook/react-vite';
import { dusty, mara, sr_message_review, sr_run_1882, sr_thread_incidents } from '@whombat/fixtures';
import { SearchResultRow } from './SearchResultRow';

const meta = {
  title: 'Search/SearchResultRow',
  component: SearchResultRow,
  parameters: { layout: 'padded' },
  args: {
    result: sr_thread_incidents,
    author: mara,
    onOpen: () => {},
  },
} satisfies Meta<typeof SearchResultRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `[28px avatar · TYPE tag · where · full name · "receipt n" · snippet]`, cited from the answer. */
export const CitedThread: Story = {};

export const CitedRun: Story = {
  args: { result: sr_run_1882, author: dusty },
};

/** The agent as the author, 28px `crop="head"` `WhombatAvatar`. */
export const AgentAuthor: Story = {
  args: { result: sr_message_review, author: dusty },
};

/** Not cited by the answer: no `receipt n` marker. */
export const Uncited: Story = {
  args: { result: { ...sr_thread_incidents, citedAs: null }, author: mara },
};
