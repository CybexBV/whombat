import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupVolume, Choices, GuestConfig, GuestFirewall, ManageResult, StorageVolume, TaskStatus } from '../../src/api/manage-types';
import type { Guest, GuestList, GuestListPage } from '../../src/api/types';
import { FixtureStore } from './state';
import { browser } from './testkit';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers({ now: Date.parse('2026-10-17T10:00:00Z') });
  const store = new FixtureStore();
  const b = browser(store);
  const task = (r: { json: unknown }) => (r.json as ManageResult).task!.id;
  const status = (id: string) => b.call('GET', `/servers/shale/tasks/${encodeURIComponent(id)}?log_start=0`).json as TaskStatus;
  const vms = () => (b.call('GET', '/servers/shale/guests?kind=vm').json as GuestList).guests.map((g) => g.id);
  return { b, task, status, vms };
}

describe('lifecycle fixtures', () => {
  it('creates a VM through a task; it then shows in the host lists and has a configuration', () => {
    const { b, task, status, vms } = setup();
    const set = { memory: '4096', cores: '2', sockets: '1', cpu: 'x86-64-v2-AES', scsihw: 'virtio-scsi-single', scsi0: 'local-zfs:32,iothread=1', ide2: 'local:iso/debian-13.1.0-amd64-netinst.iso,media=cdrom', net0: 'virtio,bridge=vmbr0,firewall=1', ostype: 'l26', agent: '1' };
    const r = b.call('POST', '/servers/shale/guests', { platform: 'pve', kind: 'vm', name: 'web-03', set });
    expect(r.status).toBe(202);
    expect((r.json as ManageResult).new_id).toBe('pve:108');
    expect(status(task(r)).status).toBe('running');
    expect(vms()).not.toContain('pve:108');
    vi.advanceTimersByTime(4000);
    expect(status(task(r)).status).toBe('ok');
    expect(vms()).toContain('pve:108');
    expect((b.call('GET', '/servers/shale/guests/pve%3A108').json as Guest).name).toBe('web-03');
    const cfg = b.call('GET', '/servers/shale/guests/pve%3A108/config').json as GuestConfig;
    expect(cfg.values.scsi0).toBe('local-zfs:vm-108-disk-0,iothread=1,size=32G');
    expect(cfg.values.net0).toMatch(/^virtio=BC:24:11:[0-9A-F:]+,bridge=vmbr0,firewall=1$/);
    expect((b.call('GET', '/servers/shale/manage/choices').json as Choices).next_id).toBe(109);
    // The same id again, a privileged container, a missing template.
    expect(b.call('POST', '/servers/shale/guests', { platform: 'pve', kind: 'vm', new_id: 108, name: 'x', set }).json).toMatchObject({ status: 409, code: 'exists' });
    const ct = { ostemplate: 'local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst', rootfs: 'local-zfs:8', unprivileged: '0' };
    expect(b.call('POST', '/servers/shale/guests', { platform: 'pve', kind: 'container', name: 'ct', set: ct }).json).toMatchObject({ status: 403, code: 'not_allowed' });
    expect(b.call('POST', '/servers/shale/guests', { platform: 'pve', kind: 'container', name: 'ct', set: { ...ct, unprivileged: '1', ostemplate: 'local:vztmpl/nope.tar.zst' } }).json).toMatchObject({
      status: 400,
      field_errors: { ostemplate: 'no such template' },
    });
  });

  it('clones a template, converts a stopped guest to a template and deletes with the name', () => {
    const { b, task, status, vms } = setup();
    const r = b.call('POST', '/servers/shale/guests/pve%3A9000/clone', { new_id: 120, name: 'web-04' });
    expect(r.status).toBe(202);
    vi.advanceTimersByTime(3000);
    expect(status(task(r)).status).toBe('ok');
    expect(vms()).toContain('pve:120');
    // Linked clones need a template.
    expect(b.call('POST', '/servers/shale/guests/pve%3A100/clone', { full: false }).json).toMatchObject({ status: 400, field_errors: { full: expect.any(String) } });
    // Convert: confirm and a stopped guest.
    expect(b.call('POST', '/servers/shale/guests/pve%3A107/template', {}).json).toMatchObject({ status: 400, code: 'confirm_required' });
    expect(b.call('POST', '/servers/shale/guests/pve%3A100/template', { confirm: true }).json).toMatchObject({ status: 409, code: 'guest_running' });
    const tpl = b.call('POST', '/servers/shale/guests/pve%3A107/template', { confirm: true });
    vi.advanceTimersByTime(2500);
    expect(status(task(tpl)).status).toBe('ok');
    expect(vms()).not.toContain('pve:107');
    expect((b.call('GET', '/servers/shale/manage/choices').json as Choices).templates?.map((t) => t.name)).toContain('win11-lab');
    // Delete: the name must match; a running guest is refused.
    expect(b.call('DELETE', '/servers/shale/guests/pve%3A120?confirm_name=web').json).toMatchObject({ status: 400, code: 'confirm_required' });
    expect(b.call('DELETE', '/servers/shale/guests/pve%3A100?confirm_name=k3s-node-2').json).toMatchObject({ status: 409, code: 'guest_running' });
    const del = b.call('DELETE', '/servers/shale/guests/pve%3A120?confirm_name=web-04&purge=1');
    expect(del.status).toBe(202);
    vi.advanceTimersByTime(3000);
    expect(status(task(del)).status).toBe('ok');
    expect(vms()).not.toContain('pve:120');
    expect(b.call('GET', '/servers/shale/guests/pve%3A120').status).toBe(404);
  });

  it('backs up, restores as a new guest and protects backups', () => {
    const { b, task, status, vms } = setup();
    const list = () => b.call('GET', '/servers/shale/guests/pve%3A100/backups').json as { items: BackupVolume[] };
    expect(list().items).toHaveLength(3);
    expect(list().items[0]).toMatchObject({ storage: 'pbs-01', verified: 'ok' });
    expect(b.call('POST', '/servers/shale/guests/pve%3A100/backups', { storage: 'local-zfs' }).json).toMatchObject({ status: 400, field_errors: { storage: expect.any(String) } });
    const r = b.call('POST', '/servers/shale/guests/pve%3A100/backups', { storage: 'pbs-01', mode: 'snapshot', notes: '{{guestname}} by hand' });
    vi.advanceTimersByTime(9000);
    expect(status(task(r)).status).toBe('ok');
    const items = list().items;
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ notes: 'k3s-node-2 by hand', storage: 'pbs-01' });
    const restore = b.call('POST', '/servers/shale/backups/restore', { platform: 'pve', volume: items[0]!.volume, new_id: 130, storage: 'vmdata', unique: true });
    expect((restore.json as ManageResult).new_id).toBe('pve:130');
    vi.advanceTimersByTime(5000);
    expect(status(task(restore)).status).toBe('ok');
    expect(vms()).toContain('pve:130');
    expect((b.call('GET', '/servers/shale/guests/pve%3A130/config').json as GuestConfig).values.scsi0).toMatch(/^vmdata:vm-130-disk-0/);
    // Over a running guest: refused.
    expect(b.call('POST', '/servers/shale/backups/restore', { platform: 'pve', volume: items[0]!.volume, guest: 'pve:100', confirm: true }).json).toMatchObject({ status: 409 });
    const prot = items.find((x) => x.protected)!;
    expect(b.call('DELETE', `/servers/shale/backups?platform=pve&volume=${encodeURIComponent(prot.volume)}`).json).toMatchObject({ status: 409, code: 'protected' });
    expect(b.call('PATCH', '/servers/shale/backups', { platform: 'pve', volume: prot.volume, protected: false, notes: 'old' }).status).toBe(200);
    expect(b.call('DELETE', `/servers/shale/backups?platform=pve&volume=${encodeURIComponent(prot.volume)}`).status).toBe(200);
    expect(list().items).toHaveLength(3);
  });

  it('downloads an ISO image, lists and deletes content, fetches appliances', () => {
    const { b, task, status } = setup();
    const isos = () => (b.call('GET', '/servers/shale/storage/local/content?platform=pve&content=iso').json as { items: StorageVolume[] }).items.map((v) => v.name);
    expect(isos()).toHaveLength(3);
    const body = { platform: 'pve', content: 'iso', url: 'https://cdimage.example/alpine-3.22.iso', filename: 'alpine-3.22.iso' };
    expect(b.call('POST', '/servers/shale/storage/local/download', { ...body, url: 'https://u:p@example/x.iso' }).json).toMatchObject({ status: 400, field_errors: { url: expect.any(String) } });
    expect(b.call('POST', '/servers/shale/storage/local/download', { ...body, filename: 'alpine.tar' }).json).toMatchObject({ status: 400, field_errors: { filename: expect.any(String) } });
    const r = b.call('POST', '/servers/shale/storage/local/download', { ...body, checksum: 'ab'.repeat(32), checksum_algorithm: 'sha256' });
    expect(r.status).toBe(202);
    vi.advanceTimersByTime(7000);
    expect(status(task(r)).log).toContain('checksum verified');
    expect(isos()).toContain('alpine-3.22.iso');
    expect((b.call('GET', '/servers/shale/manage/choices').json as Choices).isos?.map((v) => v.name)).toContain('alpine-3.22.iso');
    expect(b.call('DELETE', '/servers/shale/storage/content?platform=pve&volume=local%3Aiso%2Fvirtio-win-0.1.271.iso').status).toBe(200);
    expect(isos()).not.toContain('virtio-win-0.1.271.iso');
    expect((b.call('GET', '/servers/shale/appliances?platform=pve').json as { items: unknown[] }).items.length).toBeGreaterThan(5);
    const ap = b.call('POST', '/servers/shale/storage/local/appliances', { platform: 'pve', template: 'archlinux-base_20250901-1_amd64.tar.zst' });
    vi.advanceTimersByTime(5000);
    expect(status(task(ap)).status).toBe('ok');
    expect((b.call('GET', '/servers/shale/manage/choices').json as Choices).ct_templates?.map((v) => v.name)).toContain('archlinux-base_20250901-1_amd64.tar.zst');
  });

  it('edits the firewall with digests', () => {
    const { b } = setup();
    const fw = () => b.call('GET', '/servers/shale/guests/pve%3A201/firewall').json as GuestFirewall;
    const f1 = fw();
    expect(f1.rules.map((r) => r.macro ?? r.dport ?? r.action)).toEqual(['SSH', '443', 'monitoring', 'DROP']);
    expect(f1.cluster_enabled).toBe(false);
    expect(b.call('POST', '/servers/shale/guests/pve%3A201/firewall/rules', { rule: { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '8080', enable: true } }).status).toBe(200);
    const f2 = fw();
    expect(f2.rules[0]).toMatchObject({ pos: 0, dport: '8080' });
    expect(b.call('PUT', '/servers/shale/guests/pve%3A201/firewall/rules/0', { digest: f1.rules_digest, move_to: 1 }).json).toMatchObject({ status: 409, code: 'digest_mismatch' });
    expect(b.call('PUT', '/servers/shale/guests/pve%3A201/firewall/rules/0', { digest: f2.rules_digest, move_to: 1 }).status).toBe(200);
    expect(fw().rules[1]).toMatchObject({ dport: '8080' });
    expect(b.call('DELETE', `/servers/shale/guests/pve%3A201/firewall/rules/1?digest=${fw().rules_digest}`).status).toBe(200);
    expect(fw().rules).toHaveLength(4);
    expect(b.call('POST', '/servers/shale/guests/pve%3A201/firewall/rules', { rule: { type: 'group', action: 'nope' } }).json).toMatchObject({ status: 400, field_errors: { action: expect.any(String) } });
    expect(b.call('PUT', '/servers/shale/guests/pve%3A201/firewall/options', { digest: f1.options_digest, set: { policy_in: 'ACCEPT' } }).status).toBe(200);
    expect(fw().options.policy_in).toBe('ACCEPT');
  });

  it('sets HA and replication on the cluster', () => {
    const { b } = setup();
    const cfg = () => b.call('GET', '/servers/shale/guests/pve%3A102/config').json as GuestConfig;
    expect(cfg().ha).toBeNull();
    expect(b.call('PUT', '/servers/shale/guests/pve%3A102/ha', { state: 'started', max_restart: 2 }).status).toBe(200);
    expect(cfg().ha).toMatchObject({ state: 'started', max_restart: 2, status: 'started' });
    expect(b.call('DELETE', '/servers/shale/guests/pve%3A102/ha').status).toBe(200);
    expect(cfg().ha).toBeNull();
    expect(b.call('POST', '/servers/shale/guests/pve%3A102/replication', { target: 'nowhere' }).json).toMatchObject({ status: 400 });
    expect(b.call('POST', '/servers/shale/guests/pve%3A102/replication', { target: 'slate', schedule: '*/30', rate: '50' }).status).toBe(200);
    expect(cfg().replication).toEqual([{ id: '102-0', target: 'slate', schedule: '*/30', rate: '50', last_sync: null }]);
    expect(b.call('DELETE', '/servers/shale/guests/pve%3A102/replication/102-0').status).toBe(200);
    expect(cfg().replication).toEqual([]);
  });

  it('tags Proxmox guests and filters the guest list by tag', () => {
    const { b } = setup();
    const page = (q: string) => b.call('GET', `/guests${q}`).json as GuestListPage;
    const all = page('');
    expect(all.tags).toMatchObject({ k3s: 2, prod: 3, monitoring: 1 });
    expect(all.guests.find((g) => g.id === 'pve:100')?.tags).toEqual(['k3s', 'prod']);
    const prod = page('?tag=PROD');
    expect(prod.guests.map((g) => g.name).sort()).toEqual(['k3s-node-1', 'k3s-node-2', 'postgres-prod']);
    expect(prod.counts.all).toBe(all.counts.all);
    // Tags edited in the configuration show in the list.
    b.call('PUT', '/servers/shale/guests/pve%3A203/config', { set: { tags: 'dns;prod' } });
    expect(page('?tag=prod').total).toBe(4);
  });
});
