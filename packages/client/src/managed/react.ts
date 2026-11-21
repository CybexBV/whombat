/**
 * The managed app's session and directory hooks that the web and the phone share (`@whombat/client/managed/react`):
 * leaving a Whombat that can't be opened any more, opening one that let this device in already, and a Whombat's
 * directory entry. Each app brings its own environment.
 */
import { useEffect, useRef, useState } from 'react';
import type { ApplianceSession, ConnectionState } from '../session/types';
import type { ApplianceSummary, ControlApi } from './control';
import { letInAlready } from './pairing';
import { type GoneReason, goneOf } from './retired';

export {
  type BackupPasskeyProgress,
  type BackupPasskeyTap,
  type PasskeySetupFeedback,
  useBackupPasskeyAction,
  useOnePasskeySetup,
} from './backup-passkey-react';

/** Calls `onGone` when control ends `session` for good because its Whombat can't be opened any more. */
export function useLeaveWhenGone(session: ApplianceSession | null, onGone: (reason: GoneReason) => void) {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (!session) return;
    const check = (state: ConnectionState) => {
      const reason = goneOf(state);
      if (reason) gone.current(reason);
    };
    check(session.state());
    return session.onState(check);
  }, [session]);
}

/** Calls `onIn` once when the box says this device is in already (a box restored from a backup): nothing to pair. */
export function useOpenWhenLetIn(session: ApplianceSession | null, onIn: (accountId: string | null) => void) {
  const open = useRef(onIn);
  open.current = onIn;
  useEffect(() => {
    if (!session) return;
    let done = false;
    const check = (state: ConnectionState) => {
      const letIn = letInAlready(state);
      if (!letIn || done) return;
      done = true;
      open.current(letIn.accountId);
    };
    check(session.state());
    return session.onState(check);
  }, [session]);
}

/** A Whombat's directory entry as the hook gives it: null while loading. */
export type DirectoryEntry = ApplianceSummary | null | 'missing' | 'unreachable';

/** This organization's directory entry for a Whombat (null while loading). Compared with pins, never pinned. */
export function useDirectoryEntry(
  env: { control: Pick<ControlApi, 'appliances'> },
  orgId: string,
  device: string,
): DirectoryEntry {
  const [entry, setEntry] = useState<DirectoryEntry>(null);
  useEffect(() => {
    let live = true;
    setEntry(null);
    env.control.appliances(orgId).then(
      (list) => live && setEntry(list.find((x) => x.device === device) ?? 'missing'),
      () => live && setEntry('unreachable'),
    );
    return () => {
      live = false;
    };
  }, [env, orgId, device]);
  return entry;
}
