/**
 * Customer-approved diagnostic bundles (contracts 0.5.3 CT-52; docs/decisions/managed-runtime.md MR-42): the person's;
 * each scope from allowlisted sources, validated before it is stored; preview is the stored document; download only
 * through an export stream with the summary's sha256; limit, delete, expiry; signed events; nothing personal inside.
 */
import { createHash } from 'node:crypto';
import { DIAGNOSTICS_MAX_BUNDLES, DiagnosticBundle, diagnosticBundleBytes } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { applianceEvents, diagnosticBundles } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { verifyApplianceChain } from './audit';

const m = useManagedRuntime({ seed: true });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Result = { t: 'result'; output: Record<string, unknown> };
const output = (r: unknown) => (r as Result).output;
const ALL = ['versions', 'health', 'updates', 'backup', 'connectivity', 'errors'] as const;

let owner: Awaited<ReturnType<typeof m.enroll>>;
beforeAll(async () => {
  owner = await m.enroll(IDS.mara);
});

describe('diagnostic bundles', () => {
  it('`updates` needs the manager’s facts', async () => {
    expect(
      await (await m.client(owner)).request('diagnostics.create', { scopes: ['updates'] }),
    ).toMatchObject({
      t: 'error',
      code: 'conflict',
    });
  });

  it('builds every scope from allowlisted sources; preview is the stored document; download streams its bytes', async () => {
    m.runtime.dispatcher.facts = {
      ...m.runtime.dispatcher.facts,
      update: {
        state: 'Healthy',
        current: 'rel-test-1',
        candidate: null,
        lastCheckedAt: new Date().toISOString(),
        deferredReason: null,
        failure: 'health timeout: /secret/path', // free text never passes the code pattern
      },
    };
    const c = await m.client(owner);
    // An error for the `errors` scope.
    await c.request('enroll.pair.lookup', { code: '0000-0000' });
    const created = await c.request('diagnostics.create', { scopes: [...ALL] });
    expect(created).toMatchObject({ t: 'result', output: { scopes: [...ALL], downloads: 0 } });
    const summary = output(created) as { bundleId: string; sha256: string; size: number };

    const preview = output(await c.request('diagnostics.preview', { bundleId: summary.bundleId })) as {
      bundle: unknown;
      summary: { sha256: string };
    };
    const bytes = diagnosticBundleBytes(preview.bundle);
    expect(sha(bytes)).toBe(summary.sha256);
    expect(bytes.length).toBe(summary.size);
    const bundle = DiagnosticBundle.parse(preview.bundle);
    expect(bundle.updates).toMatchObject({ state: 'Healthy', current: 'rel-test-1', failure: null });
    expect(bundle.errors?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'not_found',
          appCode: 'pairing_code_invalid',
          op: 'enroll.pair.lookup',
        }),
      ]),
    );
    expect(bundle.connectivity?.counters.sessionsOpened).toBeGreaterThan(0);
    // Nothing that names people, accounts or paths.
    const text = new TextDecoder().decode(bytes);
    for (const needle of ['mara', 'Mara', owner.accountId, '/secret/path', '@example'])
      expect(text).not.toContain(needle);

    // Not as a plain request; through an export stream, the exact bytes.
    expect(await c.request('diagnostics.download', { bundleId: summary.bundleId })).toMatchObject({
      t: 'error',
      code: 'bad_request',
    });
    const s = await c.open({
      kind: 'export',
      op: 'diagnostics.download',
      input: { bundleId: summary.bundleId },
    });
    expect(s.answer).toMatchObject({
      t: 'opened',
      meta: {
        kind: 'export',
        contentType: 'application/json',
        name: `whombat-diagnostics-${summary.bundleId}.json`,
        size: summary.size,
      },
    });
    const got = await c.readStream(s.stream);
    expect(sha(got.bytes)).toBe(summary.sha256);
    expect(await c.waitFor((x) => x.t === 'stream_done' && x.stream === s.stream)).toMatchObject({
      sha256: summary.sha256,
    });
    expect(output(await c.request('diagnostics.list', {}))).toMatchObject({
      bundles: [{ bundleId: summary.bundleId, downloads: 1 }],
    });
    const types = (await m.t.services.db.select().from(applianceEvents)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['diagnostics.created', 'diagnostics.downloaded']));
  });

  it('at most 10; delete; expiry is a signed event; the chain verifies', async () => {
    const c = await m.client(owner);
    const existing = (output(await c.request('diagnostics.list', {})) as { bundles: unknown[] }).bundles
      .length;
    const ids: string[] = [];
    for (let i = existing; i < DIAGNOSTICS_MAX_BUNDLES; i++)
      ids.push(
        (output(await c.request('diagnostics.create', { scopes: ['versions'] })) as { bundleId: string })
          .bundleId,
      );
    expect(await c.request('diagnostics.create', { scopes: ['versions'] })).toMatchObject({
      t: 'error',
      details: { code: 'diagnostics_limit' },
    });
    expect(await c.request('diagnostics.delete', { bundleId: ids[0] })).toMatchObject({
      output: { deleted: true },
    });
    expect(await c.request('diagnostics.delete', { bundleId: ids[0] })).toMatchObject({
      output: { deleted: false },
    });
    await m.t.services.db
      .update(diagnosticBundles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(diagnosticBundles.id, ids[1] as string));
    expect(await c.request('diagnostics.preview', { bundleId: ids[1] })).toMatchObject({
      t: 'error',
      code: 'not_found',
    });
    expect(await m.runtime.diagnostics.sweep()).toBe(1);
    const expired = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'diagnostics.expired'));
    expect(expired).toHaveLength(1);
    expect(await verifyApplianceChain(m.t.services.db, m.t.services.custody)).toMatchObject({ ok: true });
  });
});
