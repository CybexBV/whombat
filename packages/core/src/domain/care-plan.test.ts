import { describe, expect, it } from 'vitest';
import { careAutomation } from '../automations/care.js';
import { validateDefinition } from '../automations/validate.js';
import { LookReportInput } from '../contracts/mcp.js';
import {
  backupStorageOf,
  backupTime,
  type CareFacts,
  type CareGuest,
  CHANGE_WINDOW_DEFAULT,
  ChangeWindow,
  careKey,
  carePushText,
  careSteps,
  careThingKey,
  changeWindowMinutes,
  changeWindowText,
  cronAt,
  inChangeWindow,
  isCareCheck,
  isTemporaryGuest,
  isTemporaryServer,
} from './care-plan.js';

const W = CHANGE_WINDOW_DEFAULT;

function facts(over: Partial<CareFacts> & Pick<CareFacts, 'server'>): CareFacts {
  return { guests: [], backupStorages: [], ...over };
}

const pve = (n: number, extra: CareGuest[] = []): CareGuest[] => [
  ...Array.from({ length: n }, (_, i) => ({
    id: `pve:${101 + i}`,
    name: `vm-${i + 1}`,
    platform: 'pve' as const,
  })),
  ...extra,
];

describe('the quiet hours for changes', () => {
  it('are 03:00–05:00 until the person moves them', () => {
    expect(W).toEqual({ start: '03:00', end: '05:00' });
    expect(changeWindowText(W)).toBe('03:00–05:00');
    expect(changeWindowMinutes(W)).toBe(120);
  });

  it('take a time inside them, and run past midnight when they end before they start', () => {
    expect(inChangeWindow('03:00', W)).toBe(true);
    expect(inChangeWindow('04:59', W)).toBe(true);
    expect(inChangeWindow('05:00', W)).toBe(false);
    const late = { start: '23:00', end: '01:00' };
    expect(inChangeWindow('23:30', late)).toBe(true);
    expect(inChangeWindow('00:30', late)).toBe(true);
    expect(inChangeWindow('12:00', late)).toBe(false);
    expect(changeWindowMinutes(late)).toBe(120);
  });

  it('refuse a window that starts when it ends, or a time that isn’t one', () => {
    expect(ChangeWindow.safeParse({ start: '03:00', end: '03:00' }).success).toBe(false);
    expect(ChangeWindow.safeParse({ start: '3:00', end: '05:00' }).success).toBe(false);
    expect(ChangeWindow.safeParse({ start: '24:00', end: '05:00' }).success).toBe(false);
  });

  it('put backups an hour before them, and write cron lines from a time', () => {
    expect(backupTime(W)).toBe('02:00');
    expect(backupTime({ start: '00:30', end: '02:00' })).toBe('23:30');
    expect(cronAt('03:00', 0)).toBe('0 3 * * 0');
    expect(cronAt('02:30')).toBe('30 2 * * *');
  });
});

describe('temporary machines (server-pages.md) are never in a plan', () => {
  it('knows them by project, name and label, never this Whombat itself', () => {
    expect(isTemporaryGuest({ id: 'incus:ci/job-1', name: 'job-1', platform: 'incus' })).toBe(true);
    expect(isTemporaryGuest({ id: 'incus:web', name: 'web', platform: 'incus' })).toBe(false);
    expect(isTemporaryGuest({ id: 'pve:120', name: 'ci-job-a8791974', platform: 'pve' })).toBe(true);
    expect(
      isTemporaryGuest({ id: 'docker:x', name: 'x', platform: 'docker', labels: { 'whombat.service': '1' } }),
    ).toBe(true);
    expect(isTemporaryGuest({ id: 'incus:ci/me', name: 'me', platform: 'incus', self: true })).toBe(false);
    expect(isTemporaryServer('ci-job-1234')).toBe(true);
    expect(isTemporaryServer(`agent-${'a'.repeat(32)}-1234abcd`)).toBe(true);
    expect(isTemporaryServer('pve-01')).toBe(false);
  });
});

describe('a care plan per kind of server (care-plan.md)', () => {
  it('Proxmox: every machine in a nightly backup to the Backup Server, keeping a week, and weekly updates', () => {
    const steps = careSteps(
      facts({
        server: { id: 'pve-01', name: 'pve-01', platform: 'proxmox', self: false },
        guests: pve(6),
        backupStorages: [
          { id: 'local', type: 'dir' },
          { id: 'pbs-01', type: 'pbs' },
        ],
      }),
      W,
    );
    expect(steps.map((s) => s.id)).toEqual(['backup', 'restore_test', 'updates']);
    expect(steps[0]?.text).toBe('Back up all 6 machines every night at 02:00 to pbs-01, keeping a week');
    expect(steps[0]?.step).toContain('backup_job_set');
    expect(steps[0]?.step).toContain('"last": 7');
    expect(steps[0]?.step).toContain('selection all');
    // Whombat turns the weekly restore test on itself (backup-trust.md).
    expect(steps[1]?.restoreTests).toBe(true);
    expect(steps[2]?.text).toBe('Install system updates on Sundays at 03:00 and restart if needed');
    expect(steps[2]?.automation).toBe('updates');
  });

  it('Proxmox without a Backup Server saves to the first storage that takes backups; temporary machines left out', () => {
    expect(backupStorageOf([{ id: 'local', type: 'dir' }])).toBe('local');
    expect(backupStorageOf([])).toBeNull();
    const steps = careSteps(
      facts({
        server: { id: 'pve-02', name: 'pve-02', platform: 'proxmox', self: false },
        guests: pve(1, [{ id: 'pve:190', name: 'ci-job-77', platform: 'pve' }]),
        backupStorages: [{ id: 'local', type: 'dir' }],
      }),
      W,
    );
    expect(steps[0]?.text).toBe('Back up vm-1 every night at 02:00 to local, keeping a week');
    // Only the person's own machine: the job lists it rather than taking every guest.
    expect(steps[0]?.step).toContain('selection guests');
    expect(steps[0]?.step).not.toContain('pve:190');
  });

  it('Proxmox without a Backup Server keeps its backups on a backup place shared over NFS (BPL-12)', () => {
    const nasShare = { serverId: 'blackbox', name: 'BlackBox' };
    const server = {
      id: 'pve-01',
      name: 'pve-01',
      platform: 'proxmox' as const,
      self: false,
      addresses: ['10.100.1.5'],
    };
    const local = [{ id: 'local', type: 'dir' }];
    const [step] = careSteps(facts({ server, guests: pve(2), backupStorages: local, nasShare }), W);
    expect(step?.text).toContain('BlackBox');
    expect(step?.step).toContain('backup_place_nfs on blackbox');
    expect(step?.step).toContain('"whombat-pve-01"');
    expect(step?.step).toContain('["10.100.1.5"]');
    expect(step?.step).toContain('proxmox_storage_add on pve-01');
    expect(step?.step).toContain('storage "blackbox-backup"');
    expect(step?.step.length).toBeLessThanOrEqual(300);
    expect(step?.step.endsWith('…')).toBe(false);
    // A storage on the network already (or a Backup Server) wins; so does a server without known addresses.
    const nfs = [...local, { id: 'nas', type: 'nfs' }];
    expect(backupStorageOf(nfs)).toBe('nas');
    expect(
      careSteps(facts({ server, guests: pve(2), backupStorages: nfs, nasShare }), W)[0]?.step,
    ).not.toContain('backup_place_nfs');
    expect(
      careSteps(
        facts({ server: { ...server, addresses: [] }, guests: pve(2), backupStorages: local, nasShare }),
        W,
      )[0]?.text,
    ).toContain('to local');
  });

  it('Incus: a daily snapshot of the default project’s machines, kept 7 days', () => {
    const steps = careSteps(
      facts({
        server: { id: 'basalt', name: 'basalt', platform: 'incus', self: false },
        guests: [
          { id: 'incus:web', name: 'web', platform: 'incus' },
          { id: 'incus:db', name: 'db', platform: 'incus' },
          { id: 'incus:ci/job-9', name: 'job-9', platform: 'incus' },
        ],
      }),
      W,
    );
    expect(steps.map((s) => s.id)).toEqual(['snapshots', 'updates']);
    expect(steps[0]?.text).toBe('Take a snapshot of the 2 machines every day at 02:00, keeping a week');
    expect(steps[0]?.step).toContain('"snapshots.schedule": "0 2 * * *"');
    expect(steps[0]?.step).toContain('"snapshots.expiry": "7d"');
    expect(steps[0]?.step).not.toContain('job-9');
  });

  it('QEMU/KVM: a weekly backup the automation takes', () => {
    const steps = careSteps(
      facts({
        server: { id: 'kvm-lab', name: 'kvm-lab', platform: 'libvirt', self: false },
        guests: [{ id: 'libvirt:win11', name: 'win11', platform: 'libvirt' }],
      }),
      W,
    );
    expect(steps.map((s) => s.id)).toEqual(['vm_backup', 'updates']);
    expect(steps[0]).toMatchObject({ automation: 'vm_backup', guests: ['libvirt:win11'] });
    expect(steps[0]?.text).toBe('Back up win11 every Sunday at 02:00');
  });

  it('a plain Linux server with apps: updates in the quiet hours, and app updates told', () => {
    const steps = careSteps(
      facts({
        server: { id: 'thetitan', name: 'thetitan', platform: 'standard', self: false },
        guests: [
          { id: 'docker:plex', name: 'plex', platform: 'docker' },
          { id: 'docker:svc', name: 'svc', platform: 'docker', labels: { 'whombat.service': '1' } },
        ],
      }),
      { start: '01:00', end: '02:30' },
    );
    expect(steps.map((s) => s.id)).toEqual(['updates', 'apps']);
    expect(steps[0]?.text).toContain('01:00');
    expect(steps[1]?.text).toBe('Tell you when apps have updates');
  });

  it('Unraid keeps its own updates; the server this Whombat runs on asks for its own', () => {
    expect(
      careSteps(facts({ server: { id: 'blackbox', name: 'blackbox', platform: 'unraid', self: false } }), W),
    ).toEqual([]);
    const self = careSteps(
      facts({ server: { id: 'home', name: 'home', platform: 'standard', self: true } }),
      W,
    );
    expect(self.map((s) => s.id)).toEqual(['updates']);
    expect(self[0]?.text).toContain('Ask you');
  });

  it('leaves a Mac’s updates to the person (they restart their computer)', () => {
    expect(
      careSteps(facts({ server: { id: 'studio', name: 'studio', platform: 'macos', self: false } }), W),
    ).toEqual([]);
  });

  it('leaves out what is in place already', () => {
    const steps = careSteps(
      facts({
        server: { id: 'pve-01', name: 'pve-01', platform: 'proxmox', self: false },
        guests: pve(2),
        backupStorages: [{ id: 'local', type: 'dir' }],
        has: { backup: true, updates: true, restore_test: true },
      }),
      W,
    );
    expect(steps).toEqual([]);
  });

  it('offers a weekly restore test on a Proxmox server with backups, never without (backup-trust.md)', () => {
    const backedUp = careSteps(
      facts({
        server: { id: 'pve-01', name: 'pve-01', platform: 'proxmox', self: false },
        guests: pve(2),
        backupStorages: [],
        has: { backup: true, updates: true },
      }),
      W,
    );
    expect(backedUp.map((s) => s.id)).toEqual(['restore_test']);
    const nowhere = careSteps(
      facts({
        server: { id: 'pve-01', name: 'pve-01', platform: 'proxmox', self: false },
        guests: pve(2),
        backupStorages: [],
        has: { updates: true },
      }),
      W,
    );
    expect(nowhere.map((s) => s.id)).toEqual([]);
  });

  it('knows the lines it answers, its own key, and says it in a push', () => {
    expect(isCareCheck('host.hint.guest.no_backup_job')).toBe(true);
    expect(isCareCheck('host.hint.incus.no_snapshots')).toBe(true);
    expect(isCareCheck('host.disk.space_high')).toBe(false);
    expect(isCareCheck(null)).toBe(false);
    expect(careKey('server:pve-01')).toBe('care:server:pve-01');
    expect(careThingKey('care:server:pve-01')).toBe('server:pve-01');
    expect(careThingKey('server:pve-01')).toBeNull();
    expect(carePushText('pve-01', 3)).toContain('3 steps');
  });

  it('is named in look_report by its ids, never with fixed', () => {
    const found = { title: 'pve-01 runs 6 machines', summary: 'Nothing is backed up yet.', fixed: false };
    expect(LookReportInput.safeParse({ ...found, care: ['backup', 'updates'] }).success).toBe(true);
    expect(LookReportInput.safeParse({ ...found, care: ['nightly'] }).success).toBe(false);
    expect(LookReportInput.safeParse({ ...found, fixed: true, care: ['backup'] }).success).toBe(false);
  });
});

describe('the automations a care plan turns on', () => {
  const base = {
    server: { id: 'pve-01', name: 'pve-01', self: false },
    window: W,
    timeZone: 'Europe/Amsterdam',
    conversationId: 'cnv_chat00000001',
  };

  it('installs updates on Sundays at the start of the quiet hours, restarting only before they end', () => {
    const a = careAutomation('updates', base);
    expect(a.name).toBe('Updates on pve-01');
    const check = validateDefinition(a.definition, Date.parse('2026-10-30T12:00:00Z'));
    expect(check.problems).toEqual([]);
    const trigger = a.definition.triggers[0];
    expect(trigger).toMatchObject({ kind: 'schedule', schedule: { expr: '0 3 * * 0' }, missed: 'skip' });
    const step = a.definition.steps[0];
    expect(step?.kind).toBe('dispatch_agent');
    const prompt = step?.kind === 'dispatch_agent' ? step.prompt : '';
    expect(prompt).toContain('server_update');
    expect(prompt).toContain('05:00');
    expect(prompt).toContain('server_power');
  });

  it('never restarts the server this Whombat runs on', () => {
    const a = careAutomation('updates', { ...base, server: { ...base.server, self: true } });
    const step = a.definition.steps[0];
    const prompt = step?.kind === 'dispatch_agent' ? step.prompt : '';
    expect(prompt).not.toContain('server_power reboot');
    expect(prompt).toContain('Never restart');
  });

  it('backs up QEMU/KVM machines on Sundays an hour before the quiet hours', () => {
    const a = careAutomation('vm_backup', { ...base, guests: ['libvirt:win11'] });
    expect(validateDefinition(a.definition, Date.parse('2026-10-30T12:00:00Z')).ok).toBe(true);
    expect(a.definition.triggers[0]).toMatchObject({ schedule: { expr: '0 2 * * 0' } });
    const step = a.definition.steps[0];
    expect(step?.kind === 'dispatch_agent' ? step.prompt : '').toContain('libvirt:win11');
  });
});
