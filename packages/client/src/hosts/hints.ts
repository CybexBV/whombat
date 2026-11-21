/**
 * A server's hints with their way out (Whombat proxmox.md PX-07): no backup job → the server's Backups tab (Add to a
 * backup job), backup old → Back up now, changes waiting → the guest (its Restart to apply), old snapshots → its
 * Snapshots, guest agent down → the guest, storage overbooked → Storage; any other hint opens its tab. The hub folds
 * guest hints per kind and names the guests in the detail (“web, db (2 changes), …”). Pure.
 */
import type { HostGuest, HostHint } from '@whombat/core/domain';
import { incusHintFixes } from './incus';
import { SERVER_TAB_WORDS, SERVER_TABS, type ServerTab } from './model';

export type HintFix =
  | { kind: 'tab'; tab: ServerTab; label: string }
  | { kind: 'guest'; guestId: string; gtab?: 'snapshots' | 'backups'; label: string }
  | { kind: 'backup'; guestId: string; label: string };

/** At most this many guests get a button of their own. */
export const HINT_GUESTS = 3;

/** The guests a folded hint names (“web, db (2 changes), …” → web, db), as the server's guests. */
export function hintGuests(h: Pick<HostHint, 'detail'>, guests: readonly HostGuest[]): HostGuest[] {
  const names = h.detail
    .split(', ')
    .map((n) => n.replace(/\s*\(.*\)$/, '').trim())
    .filter((n) => n && n !== '…');
  const out: HostGuest[] = [];
  for (const n of names) {
    const g = guests.find((x) => x.name === n);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

function tabOf(section: string | null | undefined): ServerTab | null {
  const s = (section ?? '').replace(/^#/, '');
  return (SERVER_TABS as readonly string[]).includes(s) ? (s as ServerTab) : null;
}

/** What a hint's buttons do. */
export function hintFixes(h: HostHint, guests: readonly HostGuest[]): HintFix[] {
  // Incus's hints (IU-08): no snapshot schedule → the instance's Snapshots, a full pool → Storage, a warning → System.
  const incus = incusHintFixes(h, guests);
  if (incus) return incus;
  const named = () => {
    const found = hintGuests(h, guests);
    if (found.length) return found;
    // A hint from an older hub without names: the guests the field points at.
    if (h.kind === 'guest.pending_changes') return guests.filter((g) => (g.pendingChanges ?? 0) > 0);
    if (h.kind === 'guest.agent_down') return guests.filter((g) => g.guestAgent === 'not_running');
    return [];
  };
  const each = (make: (g: HostGuest) => HintFix) => named().slice(0, HINT_GUESTS).map(make);
  switch (h.kind) {
    case 'storage.overcommit':
      return [{ kind: 'tab', tab: 'storage', label: 'Open Storage' }];
    case 'guest.no_backup_job':
      return [{ kind: 'tab', tab: 'backups', label: 'Add to a backup plan' }];
    case 'guest.backup_old':
      return each((g) => ({ kind: 'backup', guestId: g.id, label: `Back up ${g.name} now` }));
    case 'guest.pending_changes':
      return each((g) => ({ kind: 'guest', guestId: g.id, label: `See ${g.name}’s changes` }));
    case 'guest.snapshot_old':
      return each((g) => ({
        kind: 'guest',
        guestId: g.id,
        gtab: 'snapshots',
        label: `See ${g.name}’s snapshots`,
      }));
    case 'guest.agent_down':
      return each((g) => ({ kind: 'guest', guestId: g.id, label: `See ${g.name}` }));
    // A libvirt VM without a backup or a snapshot in 30 days (IU-13): its Backups tab.
    case 'libvirt.no_backup':
      return each((g) => ({ kind: 'guest', guestId: g.id, gtab: 'backups', label: `Back up ${g.name}` }));
    default: {
      const tab = tabOf(h.section);
      return tab && tab !== 'summary' ? [{ kind: 'tab', tab, label: `Open ${SERVER_TAB_WORDS[tab]}` }] : [];
    }
  }
}
