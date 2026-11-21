import { canonicalJson, sha256Hex, utf8ToBytes } from '@whombat/core/audit';
import { describe, expect, it } from 'vitest';
import { createFakeAppliance } from '../session/fake';
import { createSecureSession } from '../session/secure';
import { clientBuildNumber } from './build';
import { checkDownload, checkPreview, DiagnosticsIntegrityError, downloadDiagnostics } from './diagnostics';
import { applianceLink, parseApplianceLinkPath } from './links';

describe('client build numbers (CT-53)', () => {
  it('takes integers 0…2^31−1, from numbers or digit strings', () => {
    expect(clientBuildNumber(140)).toBe(140);
    expect(clientBuildNumber('2026100401')).toBe(2026100401);
    expect(clientBuildNumber('dev')).toBeUndefined();
    expect(clientBuildNumber(-1)).toBeUndefined();
    expect(clientBuildNumber(2 ** 31)).toBeUndefined();
    expect(clientBuildNumber(1.5)).toBeUndefined();
    expect(clientBuildNumber(undefined)).toBeUndefined();
  });
});

describe('diagnostic bundles: what is shown is what is downloaded (CT-52)', () => {
  const bundle = {
    format: 'whombat-diagnostics/1',
    bundleId: 'dgb_test0001',
    appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
    createdAt: '2026-09-26T10:00:00Z',
    expiresAt: '2026-10-03T10:00:00Z',
    windowS: 604800,
    scopes: ['versions'],
    versions: {
      runtimeVersion: '1.3.0',
      schemaVersion: 14,
      protocol: { major: 1, minor: 0 },
      releaseId: null,
      providers: [],
    },
  };
  const bytes = utf8ToBytes(canonicalJson(bundle));
  const summary = {
    bundleId: 'dgb_test0001',
    scopes: ['versions' as const],
    createdAt: bundle.createdAt,
    expiresAt: bundle.expiresAt,
    createdBy: 'acc_mara',
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    downloads: 0,
    lastDownloadedAt: null,
  };

  it('a preview that hashes to the summary is shown exactly; any change is refused', () => {
    const checked = checkPreview({ summary, bundle });
    expect(checked.text).toBe(canonicalJson(bundle));
    expect(checked.bundle?.versions?.runtimeVersion).toBe('1.3.0');
    expect(() => checkPreview({ summary, bundle: { ...bundle, scopes: ['health'] } })).toThrow(
      DiagnosticsIntegrityError,
    );
    // A newer runtime's section this client doesn't know: still shown (raw), as long as the hash holds.
    const newer = { ...bundle, future: { x: 1 } };
    const nb = utf8ToBytes(canonicalJson(newer));
    const n = checkPreview({
      summary: { ...summary, size: nb.byteLength, sha256: sha256Hex(nb) },
      bundle: newer,
    });
    expect(n.bundle).toBeNull();
    expect(n.pretty).toContain('"future"');
  });

  it('downloads through the export stream and checks the bytes', async () => {
    let served = bytes;
    const appliance = createFakeAppliance({
      handle: async () => ({ status: 200, body: {} }),
      exports: async (op, input) =>
        op === 'diagnostics.download' && (input as { bundleId: string }).bundleId === 'dgb_test0001'
          ? { contentType: 'application/json', name: 'whombat-diagnostics-dgb_test0001.json', bytes: served }
          : null,
    });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const got = await downloadDiagnostics(session, summary);
      expect(got.name).toBe('whombat-diagnostics-dgb_test0001.json');
      expect(new TextDecoder().decode(got.bytes)).toBe(canonicalJson(bundle));
      served = utf8ToBytes(canonicalJson({ ...bundle, scopes: ['health'] }));
      await expect(downloadDiagnostics(session, summary)).rejects.toThrow(DiagnosticsIntegrityError);
    } finally {
      session.close();
    }
    expect(() => checkDownload(summary, new Uint8Array(bytes.byteLength))).toThrow(DiagnosticsIntegrityError);
  });
});

describe('links that name the appliance (MR-45)', () => {
  it('build and read /appliances/<device>/<path>, leaving the journeys alone', () => {
    expect(applianceLink('https://app.whombat.com/', 'wb-1', '/burrow-hq/canvases/plan')).toBe(
      'https://app.whombat.com/appliances/wb-1/burrow-hq/canvases/plan',
    );
    expect(parseApplianceLinkPath('/appliances/wb-1/burrow-hq/runs/12')).toEqual({
      device: 'wb-1',
      path: '/burrow-hq/runs/12',
    });
    for (const p of [
      '/appliances/wb-1/pair',
      '/appliances/wb-1/recover',
      '/appliances/wb-1',
      '/appliances/wb-1/',
      '/appliances',
    ])
      expect(parseApplianceLinkPath(p)).toBeNull();
  });
});
