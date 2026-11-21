/**
 * Changing an Unraid server (Whombat incus-unraid.md IU-05…IU-07; AP-1591, AP-1592): whether it can be changed (the
 * server's Manage switch on and a Whombat that has `hosts.unraid`) and why not, and one Unraid change at a time through
 * `useManage` — host routes with `platform: unraid`, its own words while the command runs and when it's done (“The array
 * on blackbox is started.”), the task tracked like Proxmox's (PX-05).
 */

import { type UnraidOp, unraidChangeWords } from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { useCallback } from 'react';
import { type ManageOutcome, useManage } from '../manage/useManage';

export interface UnraidAccess {
  /** This server can be changed now. */
  can: boolean;
  /** Why not (Manage off, a Whombat without `hosts.unraid`); null when it can. */
  reason: string | null;
  /** The reason is the Manage switch: “Agent settings” opens it. */
  switchOff: boolean;
}

export function useUnraidAccess(_burrow: string, detail: HostServerDetail): UnraidAccess {
  const rc = detail.server.remoteControl;
  const manage = rc.manage === true;
  const reason = manage
    ? null
    : (rc.manageReason ?? `Changing ${detail.server.id} from Whombat is switched off.`);
  return { can: manage, reason, switchOff: !manage };
}

export interface UnraidChange {
  params?: Record<string, unknown>;
  confirm?: boolean;
  /** A Docker or libvirt guest's change (`container.update`, `guest.autostart`). */
  guestId?: string;
  /** The disk's, plugin's or guest's name in the words; default the whole server. */
  target?: string;
  on?: boolean;
  correct?: boolean;
  /** A refusal comes back for a dialog to show (default), or is a toast. */
  inline?: boolean;
}

/** One Unraid change at a time: `run(op, …)` resolves to the outcome (a dialog shows a refusal). */
export function useUnraidChange(burrow: string, serverId: string) {
  const { send, busy } = useManage(burrow, serverId);
  const run = useCallback(
    (op: UnraidOp, c: UnraidChange = {}): Promise<ManageOutcome> => {
      const w = unraidChangeWords(op, serverId, {
        ...(c.target !== undefined ? { target: c.target } : {}),
        ...(c.on !== undefined ? { on: c.on } : {}),
        ...(c.correct !== undefined ? { correct: c.correct } : {}),
      });
      return send(
        {
          op,
          // The guest ops' tasks are Unraid's too (`unraid:<id>`), so the tracker asks for them as such.
          platform: 'unraid',
          ...(c.guestId ? { guestId: c.guestId } : {}),
          ...(c.params ? { params: c.params } : {}),
          ...(c.confirm ? { confirm: true } : {}),
          name: c.target ?? serverId,
          what: w.what,
          done: w.finished,
          finished: w.finished,
          ...(w.started ? { started: w.started } : {}),
        },
        { inline: c.inline ?? true },
      );
    },
    [send, serverId],
  );
  return { run, busy };
}
