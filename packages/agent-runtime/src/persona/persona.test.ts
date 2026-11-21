/**
 * The helpers a turn's preface is built from (`prompt.ts`, hermes-engine.md HE-34): the person a turn names (PA-10), the
 * plan step a turn was handed (WS-04) and a card as the turn shows it.
 */
import { describe, expect, it } from 'vitest';
import { message, personal } from '../testing/contexts';
import { cardNote } from './cards';
import { personalLines } from './personal';
import { planStepLines } from './plans';

describe('personalLines (PA-10)', () => {
  it('tells the agent what of the person’s is connected (OP-01)', () => {
    const text = personalLines(personal.onBehalfOf as NonNullable<typeof personal.onBehalfOf>).join('\n');
    expect(text).toContain('Mara’s connected accounts');
    expect(text).toContain('Google as mara@gmail.com');
    expect(text).toContain('Not connected: Google Contacts.');
    expect(text).toContain('Settings → Connections');
    expect(text).not.toContain('pass provider');
  });

  it('names the providers when two accounts have the same service (CM-19)', () => {
    const base = personal.onBehalfOf as NonNullable<typeof personal.onBehalfOf>;
    const text = personalLines({
      ...base,
      connections: [
        ...base.connections,
        { provider: 'imap', email: 'mara@okafor.example', services: ['mail'] },
      ],
    }).join('\n');
    expect(text).toContain('Email (IMAP) as mara@okafor.example (Mail)');
    expect(text).toContain('pass provider (google, imap)');
  });
});

describe('planStepLines (WS-04)', () => {
  it('tells the agent which plan step it was handed, with the plan around it', () => {
    expect(planStepLines({ planStep: null })).toEqual([]);
    const lines = planStepLines({
      planStep: {
        planId: 'pln_invoice-pdf',
        stepId: 'stp_pdf-2',
        planTitle: 'Invoice PDF export',
        position: 2,
        title: 'Build the export endpoint',
        outline: ['1. Pick a PDF library — Dusty · Done', '2. Build the export endpoint — Joris · Asked'],
      },
    });
    expect(lines).toContain(
      'You were handed step 2 of the plan “Invoice PDF export”: Build the export endpoint (plan pln_invoice-pdf, step stp_pdf-2).',
    );
    expect(lines).toContain('  1. Pick a PDF library — Dusty · Done');
    expect(lines.at(-1)).toContain('A run you start in this turn is linked to the step');
  });
});

describe('cardNote', () => {
  it('says what a card holds in a few words', () => {
    expect(cardNote(message('msg_1', 'prn_dusty', '11:00', 'Plan'))).toBeNull();
    expect(
      cardNote(
        message('msg_2', 'prn_dusty', '11:01', '', {
          card: { kind: 'pill', text: 'Deploy waits for a yes', tone: 'warn' },
        }),
      ),
    ).toBe('[status: Deploy waits for a yes]');
  });

  it('says when a schedule runs and how it stands, never what the agent wrote for it (RA-30)', () => {
    const schedule = {
      id: 'sch_deploycheck',
      agentId: 'prn_dusty',
      conversationId: 'cnv_billing-v2',
      threadRootId: null,
      forAccountId: 'acc_mara',
      when: { kind: 'every' as const, minutes: 30 },
      prompt: 'Check the staging deploy.',
      status: 'active' as const,
      endedReason: null,
      nextAt: '2026-09-23T10:22:00.000Z',
      endsAt: null,
      runs: 0,
      lastRunAt: null,
      createdAt: '2026-09-23T09:22:00.000Z',
      forName: 'Mara Okafor',
      canChange: true,
    };
    const card = (s: typeof schedule | null) =>
      message('msg_3', 'prn_dusty', '11:22', '', {
        card: { kind: 'schedule', scheduleId: 'sch_deploycheck', schedule: s },
      });
    const note = cardNote(card(schedule), 'Europe/Amsterdam') ?? '';
    expect(note).toBe('[schedule: Every 30 minutes; active]');
    expect(note).not.toContain('Check the staging deploy');
    expect(cardNote(card(null))).toBe('[schedule]');
  });
});
