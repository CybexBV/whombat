import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PullRequestDetail } from '@whombat/core';
import { approval, mara, PRINCIPALS, pr, prApproved, SEED_NOW } from '@whombat/fixtures';
import { useState } from 'react';
import type { BranchTab } from '../../app/routing/search';
import { principalLookup } from '../messaging/model';
import { BranchPane } from './BranchPane';
import { BranchTabs } from './BranchTabs';
import { FilesTable } from './FilesTable';

/**
 * Branch room pieces on the mock world: the tabs, the Files changed table and the 340px pane in each
 * storyline state (changes requested → ready → merged, and a refused merge).
 */
const lookup = principalLookup({ principals: PRINCIPALS });
const viewer = { id: mara.id, kind: 'person' as const };

const STATES: Record<string, PullRequestDetail> = {
  changesRequested: { pr, status: 'changes_requested', mergeBlock: 'checks', staging: approval },
  ready: { pr: prApproved, status: 'ready', mergeBlock: null, staging: approval },
  merged: {
    pr: { ...prApproved, state: 'merged', mergedAt: SEED_NOW.toISOString(), mergedById: mara.id },
    status: 'merged',
    mergeBlock: 'not_open',
    staging: { ...approval, state: 'approved', decidedById: mara.id, decidedAt: SEED_NOW.toISOString() },
  },
};

function Room({ state, mergeError }: { state: keyof typeof STATES; mergeError?: string }) {
  const [tab, setTab] = useState<BranchTab>('files');
  const detail = STATES[state] as PullRequestDetail;
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--ink)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <BranchTabs tab={tab} fileCount={detail.pr.files.length} onTabChange={setTab} />
        {tab === 'files' ? (
          <FilesTable
            files={detail.pr.files}
            note="Every patch here is a signed event from Banjo’s key. Open any file to comment on a line."
          />
        ) : (
          <p style={{ padding: '28px 32px', color: 'var(--mut)' }}>The conversation renders here.</p>
        )}
      </div>
      <BranchPane
        detail={detail}
        lookup={lookup}
        viewer={viewer}
        now={SEED_NOW}
        timeZone="Europe/Amsterdam"
        onReviewApproval={() => {}}
        onMerge={() => {}}
        mergeError={mergeError}
      />
    </div>
  );
}

const meta = {
  title: 'Branch room/Room',
  component: Room,
  parameters: { layout: 'fullscreen' },
  args: { state: 'changesRequested' },
  argTypes: { state: { control: 'inline-radio', options: Object.keys(STATES) } },
} satisfies Meta<typeof Room>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChangesRequestedLight: Story = {
  name: 'Changes requested · light',
  globals: { theme: 'light' },
};
export const ChangesRequestedDark: Story = { name: 'Changes requested · dark', globals: { theme: 'dark' } };
export const ReadyLight: Story = {
  name: 'Ready to merge · light',
  args: { state: 'ready' },
  globals: { theme: 'light' },
};
export const ReadyDark: Story = {
  name: 'Ready to merge · dark',
  args: { state: 'ready' },
  globals: { theme: 'dark' },
};
export const Merged: Story = { name: 'Merged', args: { state: 'merged' } };
export const MergeRefused: Story = {
  name: 'Merge refused (409)',
  args: { state: 'ready', mergeError: 'Checks have to pass before this can be merged.' },
};
