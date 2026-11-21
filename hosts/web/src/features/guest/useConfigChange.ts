// Sending changes of the guest page (docs/MANAGE.md, Editing): every config
// change goes with the digest of the loaded configuration. 409
// digest_mismatch reloads it and asks for another review, 400 field_errors
// go back to the fields, 202 announces the task; afterwards the
// configuration, the guest and its host are refetched.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '../../api/client';
import { manageApi, manageKeys, type GuestConfig, type ManagePlatform, type ManageResult } from '../../api/manage';
import type { Guest } from '../../api/types';
import { errorText } from '../../components/forms';
import { toast } from '../../components/Toast';
import { t, tn } from '../../lib/i18n';
import type { ConfigDraft } from './config';
import { announceTask } from './taskEvents';

export type ChangeOutcome =
  | { ok: true; result: ManageResult }
  | {
      ok: false;
      message: string;
      /** The configuration changed meanwhile: it was reloaded, review again. */
      conflict?: boolean;
      /** config key -> message (the hub's field_errors). */
      fieldErrors?: Record<string, string>;
    };

type GuestRef = Pick<Guest, 'id' | 'name' | 'platform'>;

interface RunOpts {
  /** Errors are shown by the caller (a dialog): no error toast. */
  inline?: boolean;
  /** Success text instead of "<name>: saved." (no toast when ""). */
  done?: string;
}

/** Runs one manage change at a time for a guest, with the outcome as a toast and the right refetches. */
export function useManageChange(serverId: string, guest: GuestRef) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    for (const queryKey of [manageKeys.config(serverId, guest.id), manageKeys.guestTasks(serverId, guest.id), ['guest', serverId, guest.id], ['server', serverId], ['guests', serverId], ['guestList']]) {
      void qc.invalidateQueries({ queryKey });
    }
  }, [qc, serverId, guest.id]);

  /** `label` names the change in task toasts ("Resize scsi0 of web-01"). */
  const run = useCallback(
    async (label: string, send: () => Promise<ManageResult>, opts: RunOpts = {}): Promise<ChangeOutcome> => {
      setBusy(true);
      try {
        const result = await send();
        refresh();
        if (result.task) announceTask(serverId, guest.platform as ManagePlatform, result.task.id, label);
        else if (opts.done !== '') toast(opts.done ?? doneText(guest.name, result), 'success');
        return { ok: true, result };
      } catch (err) {
        const out = failure(err);
        if (out.conflict) await qc.refetchQueries({ queryKey: manageKeys.config(serverId, guest.id) });
        if (!opts.inline) toast(t('{action} failed: {error}', { action: label, error: out.message }), 'error');
        return out;
      } finally {
        setBusy(false);
      }
    },
    [qc, refresh, serverId, guest.name, guest.platform, guest.id],
  );

  return { run, busy, refresh };
}

/** useManageChange for configuration changes: adds the digest of the loaded configuration. */
export function useConfigChange(serverId: string, guest: GuestRef, config: GuestConfig | undefined) {
  const m = useManageChange(serverId, guest);
  const digest = config?.digest;
  const incus = guest.platform === 'incus';
  const apply = useCallback(
    (label: string, draft: ConfigDraft, opts?: RunOpts) => m.run(label, () => manageApi.setConfig(serverId, guest.id, { ...(incus ? incusDraft(draft) : draft), digest }), opts),
    [m.run, serverId, guest.id, digest, incus],
  );
  return { ...m, apply };
}

/** Incus removes a key that is set to "" (and has no pending values to revert). */
export function incusDraft(d: ConfigDraft): ConfigDraft {
  if (!d.delete?.length) return d;
  const { delete: del, ...rest } = d;
  return { ...rest, set: { ...d.set, ...Object.fromEntries(del.map((k) => [k, ''])) } };
}

/** "<name>: saved." and how many of the changes wait for a restart. */
export function doneText(name: string, r: ManageResult): string {
  const changes = r.changes ?? [];
  const pending = changes.filter((c) => c.pending).length;
  if (r.changes && changes.length === 0) return t('{name}: nothing changed.', { name });
  if (pending === 0) return t('{name}: saved.', { name });
  return tn(pending, '{name}: saved; the change applies at the next restart.', '{name}: saved; {n} changes apply at the next restart.', { name });
}

/** What went wrong, in the shape the dialogs show. */
export function failure(err: unknown): Extract<ChangeOutcome, { ok: false }> {
  if (err instanceof ApiError) {
    if (err.code === 'digest_mismatch') return { ok: false, conflict: true, message: t('Changed meanwhile — review again.') };
    const fields = err.problem?.field_errors;
    if (fields && Object.keys(fields).length) return { ok: false, fieldErrors: fields, message: err.message };
  }
  return { ok: false, message: errorText(err) };
}
