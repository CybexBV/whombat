import type { HostGuest } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { isTemporaryGuest, shownGuests, splitTemporary, TEMPORARY_WORDS } from './temporary';

type G = Pick<HostGuest, 'id' | 'name' | 'platform'> & Partial<HostGuest>;

const g = (id: string, name: string, platform: HostGuest['platform'], more: Partial<HostGuest> = {}): G => ({
  id,
  name,
  platform,
  ...more,
});

describe('isTemporaryGuest', () => {
  it('hides Incus instances outside the default project, by their project or their id', () => {
    expect(isTemporaryGuest(g('incus:ci-platform/ci-template-linux', 'ci-template-linux', 'incus'))).toBe(
      true,
    );
    expect(isTemporaryGuest(g('incus:agent-tasks/vm1', 'vm1', 'incus', { project: 'agent-tasks' }))).toBe(
      true,
    );
    expect(isTemporaryGuest(g('incus:web', 'web', 'incus', { project: 'default' }))).toBe(false);
    expect(isTemporaryGuest(g('incus:web', 'web', 'incus'))).toBe(false);
  });

  it('hides CI jobs and leased sandboxes on any platform', () => {
    expect(isTemporaryGuest(g('pve:140', 'ci-job-a8791974d2434216a8d6d605430ba24f', 'pve'))).toBe(true);
    const lease = `agent-${'5'.repeat(32)}`;
    expect(isTemporaryGuest(g(`docker:${lease}-1830224b`, `${lease}-1830224b`, 'docker'))).toBe(true);
    expect(isTemporaryGuest(g('docker:db', 'db', 'docker', { project: `${lease}-compose` }))).toBe(true);
    // A person's own names that only look alike stay.
    expect(isTemporaryGuest(g('docker:agent-smith', 'agent-smith', 'docker'))).toBe(false);
    expect(isTemporaryGuest(g('pve:101', 'ci-runner', 'pve'))).toBe(false);
  });

  it('hides the containers Whombat runs itself, by their label', () => {
    expect(isTemporaryGuest(g('docker:blog', 'blog', 'docker', { labels: { 'whombat.service': '1' } }))).toBe(
      true,
    );
    expect(isTemporaryGuest(g('docker:blog', 'blog', 'docker', { labels: { 'whombat.service': '0' } }))).toBe(
      false,
    );
  });

  it('never hides the machine this Whombat runs in', () => {
    expect(isTemporaryGuest(g('incus:lab/whombat', 'whombat', 'incus', { self: true }))).toBe(false);
  });
});

describe('splitTemporary and shownGuests', () => {
  const list = [
    g('docker:postgres', 'postgres', 'docker'),
    g('incus:ci-platform/ci-job-1', 'ci-job-1', 'incus'),
    g('incus:web', 'web', 'incus'),
    g('incus:ci-platform/ci-template-linux', 'ci-template-linux', 'incus'),
  ];

  it('keeps the order of both halves', () => {
    const { kept, temporary } = splitTemporary(list);
    expect(kept.map((x) => x.name)).toEqual(['postgres', 'web']);
    expect(temporary.map((x) => x.name)).toEqual(['ci-job-1', 'ci-template-linux']);
  });

  it('shows everything only when asked, and says how many it hides', () => {
    expect(shownGuests(list, false)).toMatchObject({ hidden: 2 });
    expect(shownGuests(list, false).shown).toHaveLength(2);
    expect(shownGuests(list, true)).toMatchObject({ hidden: 0 });
    expect(shownGuests(list, true).shown).toHaveLength(4);
  });

  it('counts the hidden ones in the row', () => {
    expect(TEMPORARY_WORDS.hidden(1)).toContain('1 temporary machine ');
    expect(TEMPORARY_WORDS.hidden(6)).toContain('6 temporary machines');
  });
});
