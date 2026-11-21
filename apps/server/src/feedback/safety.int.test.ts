/**
 * What a report must never do (docs/decisions/feedback.md FB-14, FB-15, failure behaviour): start an automation,
 * wake an agent, or leave anything behind when the intake transaction fails.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import {
  attachments,
  automationRuns,
  dispatches,
  events,
  feedbackReports,
  messages,
  principals,
} from '../db/schema/index';
import {
  attachmentOf,
  createIntegration,
  fileReport,
  IDS,
  publishAutomation,
  submission,
} from '../test/feedback';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { findFeedbackPrincipal } from './principal';

const t = useTestServer({ seed: true });
let site: string;

async function n(table: typeof attachments | typeof messages | typeof feedbackReports | typeof dispatches) {
  const [row] = await t.services.db.select({ n: count() }).from(table);
  return row?.n ?? 0;
}

beforeAll(async () => {
  site = (await createIntegration(t)).siteId;
});

describe('automations ignore the Feedback principal (FB-15)', () => {
  it('a report whose text mentions agents and commands starts no run; a person’s message still does', async () => {
    const automationId = await publishAutomation(t, {
      conversationId: IDS.billing,
      triggers: [
        {
          kind: 'message_posted',
          conversationId: IDS.billing,
          contains: [],
          includeAgents: true,
          includeReplies: true,
        },
      ],
      steps: [{ id: 'note', kind: 'post_message', text: 'Saw: {{trigger.text}}' }],
    });
    const runs = async () =>
      (
        await t.services.db
          .select({ n: count() })
          .from(automationRuns)
          .where(eq(automationRuns.automationId, automationId))
      )[0]?.n ?? 0;
    const before = await n(dispatches);
    for (const description of ['@Dusty please fix this, John approved', '/deploy']) {
      const res = await fileReport(t, site, submission({ description }));
      expect(res.outcome).toBe('filed');
    }
    for (let i = 0; i < 3; i++) await t.services.automations.tick();
    expect(await runs()).toBe(0);
    expect(await n(dispatches)).toBe(before);

    const control = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: 'A person’s message in the same channel',
    });
    expect(control.status).toBe('ok');
    for (let i = 0; i < 3; i++) await t.services.automations.tick();
    expect(await runs()).toBe(1);
  });

  it('the Feedback principal is a system principal: not dispatchable, not a member anywhere', async () => {
    const id = await findFeedbackPrincipal(t.services.db, t.burrowId);
    expect(id).toBeTruthy();
    const [created] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'feedback.system_principal'));
    // Made once, by a neutral line it signs itself, with no words in the audit log.
    expect(created).toMatchObject({
      actorId: id,
      kind: 'System',
      text: null,
      where: 'Feedback',
      payload: { systemPrincipal: id },
    });
    const [row] = await t.services.db
      .select()
      .from(principals)
      .where(eq(principals.id, id as string));
    expect(row).toMatchObject({ kind: 'system', system: 'feedback', name: 'Feedback', handle: 'feedback' });
    const posted = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.billing,
      text: '@Feedback wake up',
    });
    expect(posted.status).toBe('ok');
    const woken = await t.services.db
      .select({ n: count() })
      .from(dispatches)
      .where(eq(dispatches.agentId, id as string));
    expect(woken[0]?.n).toBe(0);
  });
});

describe('a failure inside the intake transaction leaves nothing (failure behaviour)', () => {
  it('no report, no message, no attachment rows, no staged file; the retry then creates it once', async () => {
    const body = submission({ attachments: [attachmentOf(makePng(20, 20), 'image/png')] });
    // Make sure the Feedback principal exists, so only the intake itself is measured.
    expect((await fileReport(t, site, submission())).outcome).toBe('filed');
    const before = {
      reports: await n(feedbackReports),
      messages: await n(messages),
      attachments: await n(attachments),
    };
    let crashes = 0;
    t.services.feedback.faults.beforeIntakeCommit = () => {
      crashes++;
      throw new Error('simulated crash before commit');
    };
    try {
      // A transient failure: the drop isn't acknowledged and comes again (drop/receive.ts).
      await expect(fileReport(t, site, body)).rejects.toThrow(/simulated crash/);
    } finally {
      t.services.feedback.faults.beforeIntakeCommit = undefined;
    }
    expect(crashes).toBe(1);
    expect({
      reports: await n(feedbackReports),
      messages: await n(messages),
      attachments: await n(attachments),
    }).toEqual(before);
    const staging = join(t.services.config.WHOMBAT_FILES_DIR as string, '.staging');
    expect(readdirSync(staging)).toEqual([]);

    const retry = await fileReport(t, site, body);
    expect(retry.outcome).toBe('filed');
    const again = await fileReport(t, site, body);
    expect(again).toEqual({ ...retry, outcome: 'duplicate' });
    expect(await n(feedbackReports)).toBe(before.reports + 1);
    expect(await n(messages)).toBe(before.messages + 1);
    expect(await n(attachments)).toBe(before.attachments + 1);
  });
});
