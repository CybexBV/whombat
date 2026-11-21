import type { Meta, StoryObj } from '@storybook/react-vite';
import { type Approval, approvalView, shortNameOf } from '@whombat/core';
import { at, deployApproval, dusty, mara, PRINCIPALS, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { Modal } from '../../components/Modal';
import { ApprovalDetails } from './ApprovalDetails';

/** Checks green and Waffle approved: what the mock shows once Banjo's run is done. */
const ready = (a: Approval): Approval => ({
  ...a,
  conditions: a.conditions.map((c) =>
    c.kind === 'checks_pass'
      ? { ...c, met: true, state: 'passed', passed: 41, total: 41, fixing: false, headSha: '7be20f7' }
      : c.kind === 'review_approved'
        ? { ...c, met: true, reviewState: 'approved', reviewedAt: at('11:38') }
        : c,
  ),
});
const decided = (state: 'approved' | 'declined', a: Approval): Approval => ({
  ...a,
  state,
  decidedById: mara.id,
  decidedAt: SEED_NOW.toISOString(),
  conditions: a.conditions.map((c) =>
    c.kind === 'person_approves' ? { ...c, met: state === 'approved' } : c,
  ),
});

function Demo({ approval }: { approval: Approval }) {
  const view = approvalView(approval, {
    names: (id) => {
      const p = PRINCIPALS.find((x) => x.id === id);
      return p ? { name: p.name, shortName: shortNameOf(p) } : undefined;
    },
    viewer: { id: mara.id, kind: 'person' },
    now: SEED_NOW,
    timeZone: SEED_TIME_ZONE,
    where: '#billing-v2',
  });
  return (
    <div style={{ height: '100vh' }}>
      <Modal open onOpenChange={() => {}} width="md">
        <ApprovalDetails
          approval={approval}
          view={view}
          requester={{ name: dusty.name, face: dusty.face }}
          onApprove={() => {}}
          onDecline={() => {}}
          onUndo={() => {}}
        />
      </Modal>
    </div>
  );
}

const meta = {
  title: 'Approvals/Approval modal',
  component: Demo,
  parameters: { layout: 'fullscreen' },
  args: { approval: deployApproval() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

const dark = { globals: { theme: 'dark' } };

/** 11:22 as in the mock: checks 38 of 41, changes requested → "Approve in advance". */
export const Pending: Story = {};
export const PendingDark: Story = { ...dark, name: 'Pending (dark)' };

/** Checks green and Waffle approved → "Approve and deploy". */
export const Ready: Story = { args: { approval: ready(deployApproval()) } };
export const ReadyDark: Story = {
  ...dark,
  name: 'Ready (dark)',
  args: { approval: ready(deployApproval()) },
};

/** Approved in advance, waiting for the checks: Undo until it runs. */
export const ApprovedWaiting: Story = {
  name: 'Approved · waiting for checks',
  args: { approval: decided('approved', deployApproval()) },
};

/** Approved and all green: the executor is rolling it out. */
export const Deploying: Story = {
  args: {
    approval: {
      ...decided('approved', ready(deployApproval())),
      execution: {
        state: 'running',
        startedAt: SEED_NOW.toISOString(),
        finishedAt: null,
        durationMs: null,
        resultUrl: null,
        error: null,
      },
    },
  },
};

/** Deployed: no Undo once the action has executed (B-02). */
export const Deployed: Story = {
  args: {
    approval: {
      ...decided('approved', ready(deployApproval())),
      execution: {
        state: 'succeeded',
        startedAt: SEED_NOW.toISOString(),
        finishedAt: SEED_NOW.toISOString(),
        durationMs: 134_000,
        resultUrl: 'https://staging.burrowhq.example/invoices/2026-000142.pdf',
        error: null,
      },
      executedAt: SEED_NOW.toISOString(),
    },
  },
};

/** Declined: Neo, Banjo and Waffle are told in the channel; Undo returns it to pending. */
export const Declined: Story = { args: { approval: decided('declined', deployApproval()) } };
export const DeclinedDark: Story = {
  ...dark,
  name: 'Declined (dark)',
  args: { approval: decided('declined', deployApproval()) },
};

/** A personal agent's email (connectors.md IN-16): WHAT HAPPENS, then the whole body under MESSAGE. */
const emailBody = [
  'Hi Priya,',
  'Invoice 1042 for September is paid; the transfer went out this morning and should reach you by Friday.',
  'I’ve attached the remittance advice. Let me know if the amount doesn’t match what you expected.',
  'Thanks,\nMara',
].join('\n\n');
const emailApproval = (): Approval => ({
  ...deployApproval(),
  keyId: 'mail.send',
  title: 'Send an email to priya@northwind.example',
  question: 'Send an email to priya@northwind.example?',
  target: 'Mail · mara@example.com',
  whatHappens: [
    'Send “Invoice 1042” from mara@example.com to priya@northwind.example',
    `Message: “${emailBody.slice(0, 239)}…”`,
  ],
  explainer:
    'Hazel holds “Send emails”, a key that always asks you first. If you approve, it goes ahead right away.',
  conditions: deployApproval().conditions.filter((c) => c.kind === 'person_approves'),
  action: {
    type: 'mail_send',
    params: {
      connectionEmail: 'mara@example.com',
      to: ['priya@northwind.example'],
      cc: [],
      bcc: [],
      subject: 'Invoice 1042',
      bodyPreview: emailBody.slice(0, 1000),
      body: emailBody,
      draftId: 'd1',
    },
  },
});
export const Email: Story = { args: { approval: emailApproval() } };
export const EmailDark: Story = { ...dark, name: 'Email (dark)', args: { approval: emailApproval() } };
