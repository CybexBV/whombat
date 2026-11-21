/**
 * The guest this Whombat runs in (Whombat incus-unraid.md IU-02; AP-1580): a “This Whombat” chip wherever a guest is
 * named (guest rows, the guest page's head), and one line where its changing actions would be — stopping, restarting,
 * settings, moving and deleting are left out; snapshots, backups, copies and the console stay.
 */
import { isSelfGuest, SELF_GUEST_CHIP, SELF_GUEST_LINE } from '@whombat/client/hosts';
import type { HostGuest } from '@whombat/core/domain';
import { House } from 'lucide-react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import wi from './Incus.module.css';

/** “This Whombat” after a guest's name; nothing for any other guest. */
export function SelfChip({ guest, head }: { guest: Pick<HostGuest, 'self'>; head?: boolean }) {
  if (!isSelfGuest(guest)) return null;
  return (
    <span className={cx(wi.wiSelf, head && wi.wiSelfHead)} title="The guest this Whombat runs in">
      {SELF_GUEST_CHIP}
    </span>
  );
}

/** The one line where the self guest's changing actions would be. */
export function SelfLine({ detail }: { detail?: string }) {
  return (
    <p className={wi.wiSelfLine} style={{ margin: 0 }}>
      <Icon icon={House} size={16} />
      <span>
        <b>{SELF_GUEST_LINE}</b> {detail ?? 'Stopping it or changing its settings is left out here.'}
      </span>
    </p>
  );
}
