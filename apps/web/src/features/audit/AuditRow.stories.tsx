import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AuditDisplayContext, AuditEvent } from '@whombat/core';
import { shortNameOf } from '@whombat/core';
import { dusty } from '@whombat/fixtures';
import { useState } from 'react';
import { AuditRow } from './AuditRow';

/** `evt_9f18`: Neo's staging-deploy ask, waiting on a person (`packages/fixtures/src/audit.ts`). */
const EVENT: AuditEvent = {
  v: 1,
  id: 'evt_9f18',
  burrowId: 'brw_hq',
  seq: 42,
  prevHash: '0'.repeat(64),
  actorId: dusty.id,
  type: 'approval.requested',
  kind: 'Asks',
  text: 'Asked to deploy feat/invoice-pdf to staging',
  where: '#billing-v2',
  keyUsed: { id: 'deploy.staging', label: 'Deploy to staging' },
  keyNote: 'asks a person first',
  onBehalfOf: 'Invoice PDF export plan, step 4',
  approvalId: 'apr_staging-482',
  ref: { type: 'approval', number: 12 },
  payload: {},
  createdAt: '2026-09-23T09:25:00.000Z',
  hash: '1'.repeat(64),
  sig: 'a'.repeat(128),
  signer: 'b'.repeat(64),
  fingerprint: 'b047 f0ce',
  verified: true,
  approval: null,
};

const CTX: AuditDisplayContext = {
  principal: (id) =>
    id === dusty.id ? { kind: 'agent', name: dusty.name, shortName: shortNameOf(dusty) } : undefined,
  now: '2026-09-23T11:22:00.000Z',
  timeZone: 'Europe/Amsterdam',
};

function AuditRowDemo(props: { event: AuditEvent; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!props.defaultOpen);
  return (
    <div style={{ maxWidth: 1040 }}>
      <AuditRow
        event={props.event}
        actor={dusty}
        ctx={CTX}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        onNavigate={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'Audit/AuditRow',
  component: AuditRowDemo,
  parameters: { layout: 'padded' },
  args: { event: EVENT },
} satisfies Meta<typeof AuditRowDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed row: `[48px time · 28px avatar · content · status pill]`. */
export const Collapsed: Story = {};

/** Expanded detail, indented 94px: SIGNED BY, KEY USED / KEY IT NEEDED, ON BEHALF OF, DECIDED, EVENT. */
export const Expanded: Story = {
  args: { defaultOpen: true },
};

export const Approved: Story = {
  args: {
    event: {
      ...EVENT,
      id: 'evt_approved',
      type: 'approval.decided',
      kind: 'Keys',
      text: 'Approved the deploy',
      approval: {
        number: 12,
        state: 'approved',
        decidedById: dusty.id,
        decidedAt: '2026-09-23T11:22:00.000Z',
        executedAt: null,
      },
    },
  },
};

export const Blocked: Story = {
  args: {
    event: {
      ...EVENT,
      id: 'evt_blocked',
      type: 'key.blocked',
      kind: 'Blocked',
      text: 'Blocked: no key for this action',
      approvalId: undefined,
      approval: null,
    },
  },
};
