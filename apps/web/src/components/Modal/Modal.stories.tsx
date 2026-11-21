import type { Meta, StoryObj } from '@storybook/react-vite';
import { WhombatAvatar } from '@whombat/avatars/react';
import { useState } from 'react';
import { Button } from '../Button';
import { SectionLabel } from '../SectionLabel';
import { Modal, ModalClose, ModalTitle } from './Modal';

const meta = {
  title: 'Primitives/Modal',
  component: Modal,
  parameters: { layout: 'fullscreen' },
  args: { open: true, onOpenChange: () => {}, children: null },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The agent's static avatar (Whombat five-agents.md FA-06). */
function AvatarSlot({ size }: { size: number }) {
  return <WhombatAvatar face="neo" size={size} eager />;
}

const DEPLOY_STEPS = [
  ['01', 'Build 7be20f, the latest commit on feat/invoice-pdf'],
  ['02', 'Run migrations. There are none in this change.'],
  ['03', 'Roll billing-api to staging, 2 of 2 pods'],
  ['04', 'Roll back on its own if errors stay above 1% for 5 minutes'],
] as const;

function ApprovalDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: '100vh', padding: 40 }}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Review deploy
      </Button>
      <Modal open={open} onOpenChange={setOpen} width="md">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <AvatarSlot size={64} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel tone="warn">NEO IS ASKING</SectionLabel>
            <ModalTitle
              style={{
                margin: 0,
                font: 'var(--type-heading-23)',
                letterSpacing: 'var(--type-heading-23-tracking)',
              }}
            >
              Deploy feat/invoice-pdf to staging?
            </ModalTitle>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>WHAT HAPPENS</SectionLabel>
          {DEPLOY_STEPS.map(([n, t]) => (
            <div
              key={n}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 1fr',
                gap: 10,
                fontSize: 15,
                lineHeight: 1.45,
              }}
            >
              <span style={{ font: '500 12px var(--font-mono)', color: 'var(--mut)', paddingTop: 2 }}>
                {n}
              </span>
              <span>{t}</span>
            </div>
          ))}
        </div>
        <p
          style={{
            margin: 0,
            padding: '14px 16px',
            borderRadius: 12,
            background: 'var(--sf2)',
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--ink2)',
          }}
        >
          Neo holds a staging key that only turns when a person approves. If you approve now, the deploy waits
          for the other two conditions and goes out on its own.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <ModalClose asChild>
            <Button variant="secondary" size="xl">
              Decline
            </Button>
          </ModalClose>
          <Button variant="primary" size="xl" padX={20}>
            Approve in advance
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** 560px, padded column layout (approval). Closes on overlay click, Esc, or Decline. */
export const Approval: Story = { render: () => <ApprovalDemo /> };
