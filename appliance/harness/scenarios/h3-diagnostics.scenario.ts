/**
 * (h3) Customer-approved diagnostic bundles (contracts 0.5.3 CT-52, assignment §12): the person creates a bundle with
 * every scope, previews it (the preview's canonical bytes hash to the summary), downloads it through an export stream
 * (same bytes, same sha256), lists and deletes it. The bundle carries no names, emails, account ids, burrow names,
 * message content or file paths from this appliance.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DIAGNOSTIC_SCOPES, diagnosticBundleBytes } from '@whombat/protocol/session';
import { beforeAll, describe, expect, it } from 'vitest';
import { paths } from '../src/lib/paths.ts';
import { type ApplianceSession, readExport, sessionOps } from '../src/scenario-kit/app-client.ts';
import { gap, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, ensureWorkspace } from '../src/scenario-kit/work.ts';
import { env } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('h3 diagnostic bundles', () => {
  it('create → preview (hash-bound) → download (sha256 matches) → delete; nothing personal inside', async (ctx) => {
    // Personal content the bundle must not carry.
    const marker = `diag-secret-${randomBytes(6).toString('hex')}`;
    const w = await ensureWorkspace(owner, `Diag ${marker.slice(-6)}`);
    await api(owner, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: `private note ${marker}` },
    });
    // `updates` needs the manager's update facts; that is its own test below.
    const scopes = Object.keys(DIAGNOSTIC_SCOPES).filter((x) => x !== 'updates');
    const summary = (await sessionOps.diagnosticsCreate(owner, { scopes })) as {
      bundleId: string;
      sha256: string;
      size: number;
      scopes: string[];
    };
    const preview = (await sessionOps.diagnosticsPreview(owner, summary.bundleId)) as {
      summary: { sha256: string };
      bundle: unknown;
    };
    const previewBytes = diagnosticBundleBytes(preview.bundle);
    const dl = await readExport(owner, 'diagnostics.download', { bundleId: summary.bundleId });
    const text = new TextDecoder().decode(dl.bytes);
    const listed = (await sessionOps.diagnosticsList(owner)) as {
      bundles: { bundleId: string; downloads: number }[];
    };
    const forbidden = [
      marker,
      slice.owner.email,
      slice.owner.name,
      slice.owner.accountId,
      w.slug,
      w.conversationId,
      paths.home,
      env().appliance?.identityDir ?? '/nonexistent',
      '/home/',
      '/persist/',
    ].filter((x) => x && text.includes(x));

    const deleted = (await sessionOps.diagnosticsDelete(owner, summary.bundleId)) as { deleted: boolean };
    const after = (await sessionOps.diagnosticsList(owner)) as { bundles: { bundleId: string }[] };
    note(ctx, 'diagnostics', {
      summary,
      previewSha256: sha(previewBytes),
      downloadSha256: sha(dl.bytes),
      downloadBytes: dl.bytes.byteLength,
      meta: dl.meta,
      downloads: listed.bundles.find((b) => b.bundleId === summary.bundleId)?.downloads,
      sections: Object.keys((preview.bundle as Record<string, unknown>) ?? {}),
      forbiddenFound: forbidden,
      deleted,
    });
    expect(summary.scopes.sort()).toEqual([...scopes].sort());
    expect(sha(previewBytes)).toBe(summary.sha256);
    expect(sha(dl.bytes)).toBe(summary.sha256);
    expect(dl.bytes.byteLength).toBe(summary.size);
    expect(Buffer.from(dl.bytes).equals(Buffer.from(previewBytes))).toBe(true);
    expect(listed.bundles.find((b) => b.bundleId === summary.bundleId)?.downloads).toBeGreaterThanOrEqual(1);
    expect(forbidden).toEqual([]);
    expect(deleted.deleted).toBe(true);
    expect(after.bundles.some((b) => b.bundleId === summary.bundleId)).toBe(false);
  });
  it('the runtime knows the manager’s update facts (appliance.status.update), so a bundle can include “updates”', async (ctx) => {
    const status = (await sessionOps.applianceStatus(owner)) as { update?: unknown };
    const r = await sessionOps.diagnosticsCreate(owner, { scopes: ['updates'] }).then(
      (x) => ({ created: x as { bundleId: string } }),
      (e: { status?: number; message?: string }) => ({ refused: `${e.status} ${e.message}` }),
    );
    note(ctx, 'update facts', { statusUpdate: status.update ?? null, updatesBundle: r });
    if ('created' in r) await sessionOps.diagnosticsDelete(owner, r.created.bundleId);
    else
      gap(
        ctx,
        'whombat-appliance/manager',
        'update facts reach the runtime only at manager start and on journal transitions; a runtime that starts (or restarts) after the manager has none, so appliance.status.update is empty and diagnostics refuse the updates scope',
      );
    expect(r).toHaveProperty('created');
  });
});
