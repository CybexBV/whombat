/**
 * Restoring automations (BF-04, BF-07): matched by name. A new one is made through the automations' own commands —
 * `automation.create`, its definition saved as a draft with the references remapped (`automation.save_draft`), then
 * published switched off (`automation.publish` with `enable: false`, which checks its rooms, agents and connections
 * here); one that no longer fits this Whombat stays a draft. Its keys follow (`automation.set_keys`). No webhook secret
 * comes back: switching its webhook on makes a new one. Destinations the person approved are kept.
 */
import {
  type AutomationGrant,
  type BackupAutomationRecord,
  type BackupAutomationsLine,
  type BackupDestinationRecord,
  definitionHash,
  type JsonObject,
  validateDefinition,
} from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createAutomation,
  publishAutomationDraft,
  saveAutomationDraft,
  setAutomationKeys,
} from '../../automations/commands';
import { automationGrants, loadVersion } from '../../automations/store';
import { automationDestinations, automations } from '../../db/schema/index';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreAutomations(
  run: RestoreRun,
  record: BackupAutomationsLine,
): Promise<RecordOutcome> {
  return record.type === 'automation' ? automation(run, record) : destination(run, record);
}

/** The file's definition with this burrow's ids; null when it points to something that isn't here. */
async function remapped(
  run: RestoreRun,
  value: JsonObject | null,
): Promise<{ value: JsonObject; missing: number } | null> {
  if (!value) return null;
  const out = await run.remapJson(value);
  return { value: out.value, missing: out.missing.filter((id) => !id.startsWith('new:')).length };
}

const grantKey = (gs: readonly AutomationGrant[]) =>
  gs
    .map((g) => `${g.keyId}:${g.tier}:${(g.repos ?? []).join('|')}:${(g.connections ?? []).join('|')}`)
    .sort()
    .join(',');

async function grantsHere(run: RestoreRun, r: BackupAutomationRecord): Promise<AutomationGrant[]> {
  const out: AutomationGrant[] = [];
  for (const g of r.grants) {
    const connections = g.connections
      ? (await run.resolveAll(g.connections)).ids.filter((id) => !run.isStandIn(id))
      : null;
    out.push({
      keyId: g.keyId as AutomationGrant['keyId'],
      tier: g.tier,
      ...(g.repos?.length ? { repos: g.repos } : {}),
      ...(connections?.length ? { connections } : {}),
    } as AutomationGrant);
  }
  return out;
}

/** Saves `definition` as the draft and publishes it switched off; false when it stays a draft. */
async function publishOff(run: RestoreRun, automationId: string, definition: JsonObject): Promise<boolean> {
  await saveAutomationDraft.apply(run.tx, run.ctx, { automationId, definition });
  const check = validateDefinition(definition, run.ctx.now.getTime());
  if (!check.ok) return false;
  try {
    await run.tx.transaction(async () => {
      await publishAutomationDraft.apply(run.tx, run.ctx, {
        automationId,
        enable: false,
        definitionHash: definitionHash(check.definition),
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function automation(run: RestoreRun, r: BackupAutomationRecord): Promise<RecordOutcome> {
  const definition = await remapped(run, r.definition);
  const draft = await remapped(run, r.draft);
  const [here] = await run.db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.burrowId, run.burrow.id),
        eq(automations.name, r.name),
        isNull(automations.deletedAt),
      ),
    );
  if (here) {
    run.remember(r.id, here.id, 'automation');
    run.remember(r.principal, here.principalId, 'automation');
    const live = here.currentVersion ? await loadVersion(run.db, here.id, here.currentVersion) : null;
    const liveJson = live ? JSON.stringify(live.definition) : null;
    const want = definition
      ? JSON.stringify(validateDefinition(definition.value).definition ?? definition.value)
      : null;
    const sameKeys =
      grantKey(await automationGrants(run.db, here.principalId)) === grantKey(await grantsHere(run, r));
    if ((want === null || want === liveJson) && here.description === r.description && sameKeys)
      return 'unchanged';
    return run.different(async () => {
      if (definition && want !== liveJson) {
        const published = await publishOff(run, here.id, definition.value);
        if (published) run.followUps.automationsOff++;
        else run.note('drafts', 'automations');
      }
      if (!sameKeys)
        await run.tx
          .transaction(async () =>
            setAutomationKeys.apply(run.tx, run.ctx, {
              automationId: here.id,
              grants: await grantsHere(run, r),
            }),
          )
          .catch(() => run.note('missing_reference', 'automations'));
    });
  }
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'automation');
    return 'added';
  }
  const created = await createAutomation.apply(run.tx, run.ctx, {
    name: r.name,
    description: r.description,
    source: { kind: 'blank', conversationId: 'cnv_restore' },
    publish: false,
  });
  const id = (created as { automationId: string }).automationId;
  const [row] = await run.tx.select().from(automations).where(eq(automations.id, id));
  if (!row) return 'skipped';
  run.remember(r.id, id, 'automation');
  run.remember(r.principal, row.principalId, 'automation');
  // The published definition comes back published and switched off; one that doesn't fit stays a draft (BF-07).
  const start = definition ?? draft;
  if (start) {
    const published = definition ? await publishOff(run, id, definition.value) : false;
    if (published) run.followUps.automationsOff++;
    else {
      await saveAutomationDraft.apply(run.tx, run.ctx, { automationId: id, definition: start.value });
      if (definition) run.note('drafts', 'automations');
    }
    if ((definition?.missing ?? 0) + (draft?.missing ?? 0) > 0) run.note('missing_reference', 'automations');
    // A draft kept beside the published version.
    if (published && draft && JSON.stringify(draft.value) !== JSON.stringify(definition?.value))
      await saveAutomationDraft.apply(run.tx, run.ctx, { automationId: id, definition: draft.value });
  }
  const keys = await grantsHere(run, r);
  if (keys.length)
    await run.tx
      .transaction(async () => setAutomationKeys.apply(run.tx, run.ctx, { automationId: id, grants: keys }))
      .catch(() => run.note('missing_reference', 'automations'));
  return 'added';
}

async function destination(run: RestoreRun, r: BackupDestinationRecord): Promise<RecordOutcome> {
  const [here] = await run.db
    .select({ url: automationDestinations.url })
    .from(automationDestinations)
    .where(and(eq(automationDestinations.burrowId, run.burrow.id), eq(automationDestinations.url, r.url)));
  if (here || run.dry) return 'detail';
  const approver = await run.resolve(r.approvedBy);
  await run.tx
    .insert(automationDestinations)
    .values({
      burrowId: run.burrow.id,
      url: r.url,
      approvedById: approver && !run.isStandIn(approver) ? approver : run.restorer.id,
      approvedAt: new Date(r.approvedAt),
    })
    .onConflictDoNothing();
  return 'detail';
}
