/**
 * Tracker drivers from the plugins folder (docs/decisions/report-trackers.md): a module is imported and checked — its
 * interface version, what it says about itself, its folder named after its id, every required call — whether it
 * exports a driver, a function making one or a class instance; one that can't be used is left out with why, in plain
 * words, and the others still load.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DriverLoadError, loadDriverModule, loadPlugins, PLUGIN_FILE } from './plugins';

const INFO = {
  api: 1,
  id: 'acme-desk',
  version: '1.2.0',
  words: { product: 'Acme Desk', team: 'Acme team' },
  guidance: { source: 'An Acme customer sent the report below', access: 'its tickets' },
  releasedSeparately: ['agent/'],
  prPrefix: 'Acme ticket:',
};

const CALLS = `
  async check() { return { ok: true }; },
  async health() { return { environment: null, version: null, revision: null }; },
  async poll() { return { items: [], unreadable: [], backlog: false }; },
  async item() { throw new Error('none'); },
  async diagnostics() { return { text: '', cut: false }; },
  async write() { return { wrote: {} }; },
  async send() { return { skipped: 'nothing', now: { status: 'new' } }; },
`;

/** A plugins folder with `files` (folder name → module source). */
function home(files: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'whombat-plugins-'));
  for (const [folder, source] of Object.entries(files)) {
    mkdirSync(join(dir, 'plugins', folder), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, 'plugins'), 0o755);
    chmodSync(join(dir, 'plugins', folder), 0o755);
    if (source !== null) writeFileSync(join(dir, 'plugins', folder, PLUGIN_FILE), source, { mode: 0o644 });
  }
  return dir;
}

const objectDriver = (info: Record<string, unknown> = INFO) =>
  `export default { info: ${JSON.stringify(info)}, ${CALLS} };`;

describe('loading a driver module', () => {
  it('takes a driver, a function that makes one, or a class instance with its own state', async () => {
    const dir = home({
      'acme-desk': objectDriver(),
      'acme-two': `export default async () => ({ info: ${JSON.stringify({ ...INFO, id: 'acme-two' })}, ${CALLS} });`,
      'acme-class': `
        class Driver {
          info = ${JSON.stringify({ ...INFO, id: 'acme-class' })};
          #seen = 0;
          ${CALLS.replaceAll('},\n', '}\n').replace('async check() { return { ok: true }; }', 'async check() { this.#seen++; return { ok: this.#seen > 0 }; }')}
          prLine(_conn, n) { return 'Acme ticket: #' + n; }
        }
        export default new Driver();`,
    });
    const { drivers, failed } = await loadPlugins(dir);
    expect(failed).toEqual([]);
    expect([...drivers.keys()].sort()).toEqual(['acme-class', 'acme-desk', 'acme-two']);
    const conn = { id: 'con_1', label: 'Acme', baseUrl: 'https://acme.test', token: 't' };
    const cls = drivers.get('acme-class');
    expect(await cls?.check(conn)).toEqual({ ok: true });
    expect(cls?.prLine?.(conn, 7)).toBe('Acme ticket: #7');
    // What it says about itself, as checked (defaults filled in).
    expect(drivers.get('acme-desk')?.info).toMatchObject({ id: 'acme-desk', words: INFO.words });
  });

  it('leaves out one that can’t be used, saying why, and loads the others', async () => {
    const dir = home({
      'acme-desk': objectDriver(),
      'older-api': objectDriver({ ...INFO, id: 'older-api', api: 2 }),
      'wrong-folder': objectDriver({ ...INFO, id: 'acme-other' }),
      'no-send': `export default { info: ${JSON.stringify({ ...INFO, id: 'no-send' })}, ${CALLS.replace(/ {2}async send\(\).*\n/, '')} };`,
      'bad-words': objectDriver({ ...INFO, id: 'bad-words', words: { product: '' } }),
      broken: 'export default {',
      throws: 'export default () => { throw new Error("no licence file"); };',
      'just-a-folder': null,
    });
    const { drivers, failed } = await loadPlugins(dir);
    expect([...drivers.keys()]).toEqual(['acme-desk']);
    const why = Object.fromEntries(failed.map((f) => [f.folder, f.reason]));
    expect(Object.keys(why).sort()).toEqual([
      'bad-words',
      'broken',
      'no-send',
      'older-api',
      'throws',
      'wrong-folder',
    ]);
    expect(why['older-api']).toContain('interface 2');
    expect(why['wrong-folder']).toContain('acme-other');
    expect(why['no-send']).toContain('send');
    expect(why.throws).toContain('no licence file');
  });

  it('goes on without a driver that takes too long to load or to start', async () => {
    const dir = home({
      'acme-desk': objectDriver(),
      hangs: 'await new Promise(() => {});\nexport default {};',
      'slow-start': 'export default () => new Promise(() => {});',
    });
    const { drivers, failed } = await loadPlugins(dir, { deadlineMs: 50 });
    expect([...drivers.keys()]).toEqual(['acme-desk']);
    expect(failed.map((f) => f.folder).sort()).toEqual(['hangs', 'slow-start']);
    for (const f of failed) expect(f.reason).toContain('took longer');
  });

  it('gives loading and starting one deadline together, not one each', async () => {
    const info = JSON.stringify({ ...INFO, id: 'slow-both' });
    const dir = home({
      // Each half alone fits the deadline; both together don't.
      'slow-both': `await new Promise((r) => setTimeout(r, 150));
export default () => new Promise((r) => setTimeout(() => r({ info: ${info}, ${CALLS} }), 150));`,
    });
    const { drivers, failed } = await loadPlugins(dir, { deadlineMs: 220 });
    expect(drivers.size).toBe(0);
    expect(failed[0]?.reason).toContain('took longer');
  });

  it('refuses a driver someone other than its owner can change', async () => {
    const dir = home({ 'acme-desk': objectDriver() });
    chmodSync(join(dir, 'plugins', 'acme-desk', PLUGIN_FILE), 0o666);
    const { drivers, failed } = await loadPlugins(dir);
    expect(drivers.size).toBe(0);
    expect(failed[0]?.reason).toContain('chmod go-w');
  });

  it('answers nothing for a home without a plugins folder, and refuses a missing file', async () => {
    expect(await loadPlugins(mkdtempSync(join(tmpdir(), 'whombat-home-')))).toEqual({
      drivers: new Map(),
      failed: [],
    });
    await expect(loadDriverModule(join(tmpdir(), 'nowhere', PLUGIN_FILE))).rejects.toBeInstanceOf(
      DriverLoadError,
    );
  });
});
