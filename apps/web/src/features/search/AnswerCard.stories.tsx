import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SearchAnswer } from '@whombat/core';
import { dusty, searchAnswer } from '@whombat/fixtures';
import { AnswerCard } from './AnswerCard';

const meta = {
  title: 'Search/AnswerCard',
  component: AnswerCard,
  parameters: { layout: 'padded' },
  args: {
    answer: searchAnswer,
    agentName: dusty.name,
    agentFace: dusty.face,
    onAction: () => {},
  },
} satisfies Meta<typeof AnswerCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Dusty's answer to the mock's own query: inline numbered citations, `Post to #incidents` / `Open PR #482`. */
export const Ready: Story = {};

const pendingAnswer: SearchAnswer = {
  ...searchAnswer,
  id: 'ans_pending',
  status: 'pending',
  text: '',
  citations: [],
  durationMs: null,
  actions: [],
};

/** While Dusty is thinking (`search.ask` in flight, no simulated realtime push in fixture mode). */
export const Pending: Story = {
  args: { answer: pendingAnswer },
};

const failedAnswer: SearchAnswer = { ...pendingAnswer, id: 'ans_failed', status: 'failed' };

export const Failed: Story = {
  args: { answer: failedAnswer },
};
