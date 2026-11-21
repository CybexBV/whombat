import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AssessmentCard as AssessmentCardData } from '@whombat/core/domain';
import { assessmentCardOf, reportFeature, reportLikelyBug } from '@whombat/fixtures';
import { AssessmentCard } from './AssessmentCard';

const bug = assessmentCardOf(reportLikelyBug) as AssessmentCardData;
const feature = assessmentCardOf(reportFeature) as AssessmentCardData;

/** Pepper's duplicate from DEV (FB-7H4R-45MG), as the new card shows it. */
const duplicate: AssessmentCardData = {
  ...feature,
  reference: 'FB-7H4R-45MG',
  assessment: {
    ...feature.assessment,
    outcome: 'duplicate',
    duplicateOf: 'FB-2P7K-8T73',
    summary:
      'Duplicate company-details request; the live homepage already has a Contact modal with the requested address, using info@whombat.com rather than the suggested hello@whombat.com.',
    reproduction: {
      status: 'attempted_not_reproduced',
      notes: 'Opened https://whombat.com/, clicked footer Contact, and inspected the resulting dialog.',
    },
    evidence: [
      {
        kind: 'observation',
        ref: 'https://whombat.com/',
        note: 'Clicking footer Contact opens a dialog with the company name, address and info@whombat.com.',
        hypothesis: false,
      },
    ],
  },
  decision: {
    question: 'Do you want to switch the address to hello@whombat.com?',
    options: [
      { label: 'Keep info@', action: 'resolve', recommended: true },
      { label: 'Switch to hello@', action: 'hand_off', recommended: false },
      { label: 'Close as duplicate', action: 'close', recommended: false },
    ],
  },
};

const meta = {
  title: 'Cards/Assessment',
  component: AssessmentCard,
  args: { canDecide: true, onDecide: (i: number) => console.info('decide', i) },
  decorators: [
    (Story) => (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AssessmentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Duplicate: Story = { args: { card: duplicate } };
export const BugToDecide: Story = { args: { card: bug } };
export const Deciding: Story = { args: { card: bug, deciding: 0 } };
export const Decided: Story = {
  args: {
    card: {
      ...bug,
      status: 'closed',
      decided: {
        option: 1,
        label: 'Leave it for now',
        action: 'keep_open',
        decidedById: 'prn_mara',
        decidedAt: '2026-09-30T14:10:00.000Z',
      },
    },
    decidedText: 'Mara chose “Leave it for now” · kept open · 16:10',
  },
};
export const FeatureOpen: Story = { args: { card: feature, defaultExpanded: true } };
export const NoDecision: Story = { args: { card: { ...bug, bugVerdict: 'not_a_bug', decision: null } } };
