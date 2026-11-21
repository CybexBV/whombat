/** The phone's guest screen and a server's Backups as view models (app docs/decisions/proxmox-mobile.md AP-1485…). */
import type { HostBackupJob, HostGuest, HostGuestDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsWorld } from './fixtures';
import {
  addToJobParams,
  backupJobRows,
  backupRows,
  defaultSnapshotName,
  deleteCheck,
  editDraft,
  editStart,
  followEndText,
  followWords,
  growDisk,
  guestBackupLine,
  guestHead,
  guestHints,
  guestSettingGroups,
  jobCoverage,
  jobCovers,
  latestBackups,
  manageOffText,
  newIdCheck,
  pendingLines,
  phoneGuestTabs,
  reviewLines,
  scheduleWords,
  serverHintWayOut,
  snapshotNameError,
  snapshotRows,
  taskRows,
} from './guest-mobile';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const TZ = 'Europe/Amsterdam';
const DAY = 86_400_000;
/** The views write a no-break space before units (“64 GiB”); the expectations use a plain one. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\u00a0/g, ' '));
const world = createHostsWorld(NOW);
const pve02 = world.guests.get('pve-02') ?? [];
const vm = pve02.find((g) => g.kind === 'vm' && g.state === 'running') as HostGuest;
const ct = pve02.find((g) => g.kind === 'container') as HostGuest;
const vmCfg = world.configs.get(`pve-02/${vm.id}`);
const ctCfg = world.configs.get(`pve-02/${ct.id}`);
if (!vmCfg || !ctCfg) throw new Error('the fixture world has configs');

const ALL = { console: true, power: true, manage: true };
const detail = (g: HostGuest, over: Partial<HostGuestDetail> = {}): HostGuestDetail => ({
  ...g,
  remoteControl: ALL,
  manageable: true,
  ...over,
});

describe('the phone’s guest tabs (AP-1485)', () => {
  it('folds the web’s eight into five, with Manage on', () => {
    expect(phoneGuestTabs(detail(vm))).toEqual(['summary', 'settings', 'snapshots', 'backups', 'tasks']);
  });

  it('shows the Summary alone, saying why, while Manage is off', () => {
    const off = detail(vm, {
      manageable: false,
      remoteControl: {
        ...ALL,
        manage: false,
        manageReason: 'Guest editing is switched off on pve-02 itself.',
      },
    });
    expect(phoneGuestTabs(off)).toEqual(['summary']);
    expect(manageOffText(off, 'pve-02')).toBe('Guest editing is switched off on pve-02 itself.');
    expect(manageOffText({ ...off, remoteControl: ALL }, 'pve-02')).toBe(
      'Changing guests is switched off for pve-02.',
    );
    // Docker guests aren't changed from Whombat: nothing to explain.
    expect(manageOffText({ ...off, platform: 'docker' }, 'pve-02')).toBeNull();
  });

  it('keeps Incus to its Summary and Snapshots', () => {
    expect(phoneGuestTabs(detail({ ...vm, platform: 'incus' }))).toEqual(['summary', 'snapshots']);
  });
});

describe('the header and the Summary (AP-1486, AP-1492)', () => {
  it('draws the kind as a mark with the id beside the name, the node in the line, all of it read (AP-1810)', () => {
    const h = guestHead({ ...vm, tags: ['prod', 'k3s'] });
    expect(h.line).toBe(vm.node ?? 'pve-02');
    expect(h.kind).toEqual({ glyph: 'vm', label: `Proxmox VM ${vm.vmid}`, id: String(vm.vmid) });
    expect(h.tone).toBe('ok');
    expect(h.label).toContain(`Proxmox VM ${vm.vmid}`);
    expect(h.label).toContain('Running');
    expect(h.label).toContain('tags prod, k3s');
  });

  it('says the last backup and whether a job covers it', () => {
    const at = new Date(NOW - 10 * 3600_000).toISOString();
    expect(guestBackupLine({ lastBackup: { result: 'ok', at }, backupJob: true }, NOW, TZ)).toEqual({
      last: 'Today 04:02 · went fine',
      lastTone: 'ok',
      job: 'In a backup plan',
      inJob: true,
    });
    expect(guestBackupLine({ lastBackup: null, backupJob: false }, NOW, TZ)).toMatchObject({
      last: 'None yet',
      job: 'In no backup plan',
    });
  });

  it('gives each Proxmox hint its way out (PX-07)', () => {
    const old = new Date(NOW - 41 * DAY).toISOString();
    const hints = guestHints(
      {
        ...vm,
        backupJob: false,
        pendingChanges: 2,
        oldestSnapshot: old,
        guestAgent: 'not_running',
      },
      NOW,
      { jobs: true },
    );
    expect(hints.map((h) => [h.title, h.action?.label ?? null])).toEqual([
      ['In no backup plan', 'Add to a backup plan'],
      ['2 changes wait for a restart', 'Restart to apply'],
      ['An old snapshot', 'Snapshots'],
      ['It doesn’t report what’s inside', null],
    ]);
    // Without backup jobs on this Whombat, Back up now is the way out.
    expect(guestHints({ ...vm, backupJob: false }, NOW)[0]?.action?.label).toBe('Back up now');
    const stale = guestHints(
      {
        ...vm,
        backupJob: true,
        pendingChanges: 0,
        lastBackup: { result: 'ok', at: new Date(NOW - 12 * DAY).toISOString() },
      },
      NOW,
    );
    expect(stale.map((h) => [h.title, h.detail, h.action?.to])).toEqual([
      ['No recent backup', 'The last one is 12 days old.', 'back_up'],
    ]);
  });

  it('opens a server’s hint where it is fixed', () => {
    expect(serverHintWayOut('guest.no_backup_job')).toEqual({ label: 'Backups', to: 'backups' });
    expect(serverHintWayOut('guest.pending_changes')?.to).toBe('guests');
    expect(serverHintWayOut('storage.overcommit')).toBeNull();
  });

  it('lists what waits for a restart, now → after', () => {
    expect(
      plain(pendingLines({ ...vmCfg, pending: { memory: '8192' }, pendingDelete: ['balloon'] })),
    ).toEqual([
      { key: 'balloon', label: 'Can shrink to', now: expect.any(String), after: 'removed' },
      { key: 'memory', label: 'Memory', now: expect.any(String), after: '8 GiB' },
    ]);
  });
});

describe('Settings (AP-1493, AP-1494)', () => {
  it('reads a VM in five groups with the everyday edits marked', () => {
    const groups = guestSettingGroups(vmCfg, vm.name);
    expect(groups.map((g) => g.title)).toEqual(['Processors', 'Memory', 'Disks', 'Network', 'Options']);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.filter((r) => r.edit).map((r) => r.edit)).toEqual([
      'cores',
      'memory',
      'name',
      'onboot',
      'protection',
      'tags',
      'description',
    ]);
    expect(plain(rows.find((r) => r.id === 'scsi0'))).toMatchObject({ value: '64 GiB', grow: 'scsi0' });
    expect(rows.find((r) => r.id === 'ide2')?.value).toBe('Cloud-init settings');
    expect(rows.find((r) => r.id === 'net0')?.value).toBe('vmbr0');
  });

  it('locks a key Proxmox keeps to itself', () => {
    const rows = guestSettingGroups({ ...vmCfg, restricted: ['memory'] }, vm.name).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === 'memory')).toMatchObject({ locked: true });
    expect(rows.find((r) => r.id === 'memory')?.edit).toBeUndefined();
  });

  it('reads a container’s root disk and hostname', () => {
    const rows = guestSettingGroups(ctCfg, ct.name).flatMap((g) => g.rows);
    expect(plain(rows.find((r) => r.id === 'rootfs'))).toMatchObject({ label: 'Root disk', value: '16 GiB' });
    expect(rows.find((r) => r.id === 'name')?.value).toBe(ct.name);
  });

  it('turns each edit into the review’s lines, old → new', () => {
    const memory = editDraft(vmCfg, 'memory', { text: '12288', on: false });
    expect(memory.error).toBeNull();
    expect(plain(reviewLines(vmCfg, memory.draft ?? {}))).toEqual([
      { key: 'memory', label: 'Memory', old: expect.stringMatching(/GiB$/), new: '12 GiB' },
    ]);
    expect(editDraft(vmCfg, 'memory', { text: '8', on: false }).error).toBe('At least 16.');
    expect(editDraft(vmCfg, 'cores', { text: 'four', on: false }).error).toBe('Use a whole number.');
    expect(editDraft(vmCfg, 'name', { text: 'web 1', on: false }).error).toBe(
      'Letters, digits, dots and dashes.',
    );
    // Start with the server off: the key goes (Proxmox's default).
    const onboot = editDraft(vmCfg, 'onboot', { text: '', on: false });
    expect(onboot.draft).toEqual({ delete: ['onboot'] });
    expect(reviewLines(vmCfg, onboot.draft ?? {})).toEqual([
      { key: 'onboot', label: 'Start with the server', old: 'Yes', new: 'removed' },
    ]);
    const tags = editDraft(vmCfg, 'tags', { text: 'prod  k3s', on: false });
    expect(tags.draft).toEqual({ set: { tags: 'prod;k3s' } });
    expect(editDraft(vmCfg, 'tags', { text: 'bad/tag', on: false }).error).toMatch(/^A tag starts/);
    // Nothing that is already so is sent.
    expect(editDraft(vmCfg, 'cores', { text: vmCfg.values.cores ?? '', on: false }).draft).toEqual({});
  });

  it('starts an edit from the value waiting for a restart', () => {
    expect(editStart({ ...vmCfg, pending: { memory: '16384' } }, 'memory').text).toBe('16384');
    expect(editStart(vmCfg, 'onboot').on).toBe(true);
  });

  it('grows a disk, never shrinks it', () => {
    const g = growDisk(vmCfg, 'scsi0', '8');
    expect(g.params).toEqual({ disk: 'scsi0', size: '+8G' });
    expect(plain(g.line)).toMatchObject({ old: '64 GiB', new: '72 GiB' });
    expect(growDisk(vmCfg, 'scsi0', '0').error).toBe('At least 1.');
  });
});

describe('Snapshots, Backups and Tasks (AP-1495…AP-1497)', () => {
  it('lists the snapshots to go back to, newest first', () => {
    const rows = snapshotRows(world.snapshots.get(`pve-02/${vm.id}`) ?? [], NOW, TZ);
    expect(rows.map((r) => [r.name, r.line])).toEqual([
      ['weekly', 'Taken Thu 14:02 · with memory'],
      ['before-upgrade', 'Taken 8 Oct, 14:02'],
    ]);
    expect(snapshotNameError('before-2026-10-17')).toBeNull();
    expect(snapshotNameError('2026')).toMatch(/^Starts with a letter/);
    expect(defaultSnapshotName(NOW)).toBe('before-2026-10-17');
  });

  it('lists the backups newest first, with size, place and whether kept', () => {
    const mine = world.backups.filter((b) => b.guest === '118');
    const rows = backupRows(mine, NOW, TZ);
    expect(rows[0]?.title).toBe('Today 02:02');
    expect(rows.at(-1)?.line).toMatch(/ · pbs · kept$/);
    const latest = latestBackups(world.backups, pve02, NOW, TZ, 3);
    expect(latest).toHaveLength(3);
    expect(latest[0]?.title).toMatch(/ · Today 02:02$/);
  });

  it('says what each task was and how it went', () => {
    const rows = taskRows(world.tasks.get(`pve-02/${vm.id}`) ?? [], NOW, TZ);
    expect(plain(rows.map((r) => [r.title, r.status.text, r.line]))).toEqual([
      ['Backup', 'Done', 'Today 02:02 · took 45 s · whombat@pve'],
      ['Start', 'Done', `${rows[1]?.line.split(',')[0]}, 14:02 · took 4 s · john@pam`],
    ]);
  });

  it('checks a delete and a new id', () => {
    expect(deleteCheck({ name: 'web', state: 'running' }, 'web')).toEqual({
      ok: false,
      reason: 'Shut web down first.',
    });
    expect(deleteCheck({ name: 'web', state: 'stopped' }, 'we').ok).toBe(false);
    expect(deleteCheck({ name: 'web', state: 'stopped' }, ' web ').ok).toBe(true);
    expect(newIdCheck('', 146)).toEqual({ id: 146, error: null });
    expect(newIdCheck('42', 146).error).toBe('Use a number from 100.');
  });
});

describe('started and finished (PX-05, AP-1490)', () => {
  it('says when long work starts and how it ended', () => {
    const w = followWords('backup.create', 'web');
    expect(w.started).toBe('The backup of web started.');
    expect(followEndText(w, 'ok')).toBe('The backup of web is done.');
    expect(followEndText(w, 'warning')).toBe('The backup of web is done, with warnings.');
    expect(followEndText(w, 'error', 'storage pbs is full')).toBe(
      'The backup of web didn’t work. Storage pbs is full.',
    );
    expect(followEndText(w, 'error', 'x'.repeat(200))).toBe('The backup of web didn’t work.');
    expect(followWords('snapshot_restore', 'web', 'weekly').done).toBe('web is back at “weekly”.');
  });
});

describe('backup jobs (PX-03, AP-1498)', () => {
  const job = (over: Partial<HostBackupJob>): HostBackupJob => ({
    id: 'backup-1',
    enabled: true,
    schedule: '04:00',
    storage: 'pbs',
    selection: 'all',
    mode: 'snapshot',
    nextRun: new Date(NOW + 14 * 3600_000).toISOString(),
    ...over,
  });

  it('says when a job runs, what it covers and when next', () => {
    expect(scheduleWords('4:00')).toBe('Every day at 04:00');
    expect(scheduleWords('sat 02:00')).toBe('Saturdays at 02:00');
    expect(scheduleWords('mon..fri 03:30')).toBe('Weekdays at 03:30');
    expect(scheduleWords('*/3:00')).toBe('*/3:00');
    const guests = [
      { id: 'pve:101', name: 'web' },
      { id: 'pve:102', name: 'db' },
      { id: 'pve:103', name: 'old' },
    ];
    expect(jobCoverage(job({}), guests)).toBe('Every guest');
    expect(jobCoverage(job({ exclude: ['pve:103'] }), guests)).toBe('Every guest but old');
    expect(jobCoverage(job({ selection: 'guests', guests: ['pve:101', 'pve:102', 'pve:103'] }), guests)).toBe(
      'web, db and 1 more',
    );
    expect(jobCoverage(job({ selection: 'pool', pool: 'prod' }), guests)).toBe('The pool prod');
    const rows = backupJobRows([job({ enabled: false, id: 'b' }), job({})], guests, NOW, TZ);
    expect(rows.map((r) => [r.id, r.title, r.line, r.next])).toEqual([
      ['backup-1', 'Every day at 04:00', 'pbs · Every guest', 'Next Sun 04:02'],
      ['b', 'Every day at 04:00', 'pbs · Every guest', 'Paused'],
    ]);
  });

  it('adds a guest to a job: onto its list, or off its exclusions', () => {
    expect(jobCovers(job({ exclude: ['pve:101'] }), 'pve:101')).toBe(false);
    expect(addToJobParams(job({ exclude: ['pve:101', 'pve:9'] }), 'pve:101')).toEqual({
      jobId: 'backup-1',
      exclude: ['pve:9'],
    });
    expect(addToJobParams(job({ selection: 'guests', guests: ['pve:9'] }), 'pve:101')).toEqual({
      jobId: 'backup-1',
      guests: ['pve:9', 'pve:101'],
    });
    expect(addToJobParams(job({ selection: 'pool', pool: 'prod' }), 'pve:101')).toBeNull();
  });
});
