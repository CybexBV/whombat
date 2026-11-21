import { render, screen } from '@testing-library/react';
import { type Approval, approvalView } from '@whombat/core';
import { deployApproval, mara, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { Modal } from '../../components/Modal';
import { ApprovalDetails } from './ApprovalDetails';

function renderDetails(approval: Approval) {
  const view = approvalView(approval, {
    names: () => ({ name: 'Hazel', shortName: 'Hazel' }),
    viewer: { id: mara.id, kind: 'person' },
    now: SEED_NOW,
    timeZone: SEED_TIME_ZONE,
    where: 'Chat',
  });
  render(
    <Modal open onOpenChange={() => {}} width="md">
      <ApprovalDetails approval={approval} view={view} requester={{ name: 'Hazel', face: 'hazel' }} />
    </Modal>,
  );
}

describe('approval details: MESSAGE (connectors.md IN-16)', () => {
  it('shows the whole body of an email, past what WHAT HAPPENS clips', () => {
    const body = `${'Harmless first paragraph. '.repeat(50)}\n\nThe part after character 1000.`;
    renderDetails({
      ...deployApproval(),
      keyId: 'mail.send',
      action: {
        type: 'mail_send',
        params: {
          connectionEmail: 'mara@example.com',
          to: ['hugo@example.com'],
          cc: [],
          bcc: [],
          subject: 'Invoice',
          bodyPreview: body.slice(0, 1000),
          body,
          draftId: 'd1',
        },
      },
    });
    expect(screen.getByText('MESSAGE')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'The whole message' }).textContent).toBe(body);
  });

  it('has no MESSAGE for other actions', () => {
    renderDetails(deployApproval());
    expect(screen.queryByText('MESSAGE')).toBeNull();
  });
});

describe('approval details: a Hermes tool at Ask (CT-1236)', () => {
  it('shows a web lookup as a command card in the contracts’ words', () => {
    renderDetails({
      ...deployApproval(),
      keyId: 'web.browse',
      action: {
        type: 'run_command',
        params: { command: 'web_search “vat rounding rules”', category: 'web', target: null, reason: null },
      },
    });
    expect(screen.getAllByRole('heading')[0]?.textContent).toMatch(/web/i);
  });
});
