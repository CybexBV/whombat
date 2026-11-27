/**
 * One server change at a time from the phone (proxmox-mobile.md AP-1490, AP-1491): `hosts.manage` and
 * `hosts.guestAction`, the note that it was done or started (PX-05: a task is followed until it ends, then one more
 * note says how), and a refusal handed back for the sheet to show — the service's words, field errors by config key,
 * and “Changed meanwhile — review again.” after which the configuration is read again so the review shows what is
 * there now. A change that waits for an approval or a key says so in the app's alert and closes the sheet.
 */
import { useQueryClient } from '@tanstack/react-query';
import { actionAcceptedText, commitOutcomeText, hostErrorInfo, manageDoneText } from '@whombat/client/hosts';
import { followWords, taskPlatform } from '@whombat/client/hosts/mobile';
import { useHostsChange } from '@whombat/client/hosts/react';
import { queryKeys } from '@whombat/client/query';
import { api, type HostGuestAction, type HostManageOp, type HostManageResult } from '@whombat/core';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { followHostTask } from '../../data/hostTasks';
import { mobileTranslator, useI18n } from '../../i18n';
import { showNotice } from '../feedback';

export interface ManageSend {
  op: HostManageOp;
  guestId?: string;
  /** Host routes: `pve`, `incus`, `unraid`, `libvirt`, or `host` for the package ops (the host's when left out). */
  platform?: 'pve' | 'incus' | 'unraid' | 'libvirt' | 'host';
  params?: Record<string, unknown>;
  digest?: string;
  confirm?: boolean;
  confirmName?: string;
  /** Names the thing changed in the notes (“web”). */
  name: string;
  /** The note when it was done at once, where the op's own words don't fit (“The backup job is paused.”). */
  done?: string;
  /**
   * The words of a task it starts, where the op's own don't fit (`guest.copy`, `guest.rename` with the new name,
   * `backup.restore_new`, a disk's name for a spin); `false`: say it started and don't follow it (a parity check
   * runs for hours; Whombat says how it ended, IU-07).
   */
  follow?: { kind: string; extra?: string } | false;
}

export type ChangeOutcome =
  | { ok: true; result?: HostManageResult }
  /** It waits for a person or a key: the alert said so; close the sheet. */
  | { ok: false; waiting: true }
  | { ok: false; waiting?: false; message: string; conflict: boolean; fields: Record<string, string> };

function refusal(error: unknown, locale?: string | null): Extract<ChangeOutcome, { message: string }> {
  const info = hostErrorInfo(error, locale);
  return { ok: false, message: info.message, conflict: info.conflict, fields: info.fields };
}

function waiting(result: Parameters<typeof commitOutcomeText>[0], locale?: string | null): ChangeOutcome {
  const text = commitOutcomeText(result, locale);
  if (text) Alert.alert(mobileTranslator(locale).t('screens2.common.notYet'), text);
  return { ok: false, waiting: true };
}

/** `hosts.manage` on one server. */
export function useManageChange(serverId: string) {
  const { rawLocale } = useI18n();
  const { slug } = useBurrowBase();
  const change = useHostsChange(api.hosts.manage);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const send = useCallback(
    async (s: ManageSend): Promise<ChangeOutcome> => {
      setBusy(true);
      try {
        const result = await change.mutateAsync({
          params: { burrow: slug, serverId },
          body: {
            op: s.op,
            ...(s.guestId ? { guestId: s.guestId } : {}),
            ...(s.platform ? { platform: s.platform } : {}),
            params: (s.params ?? {}) as never,
            ...(s.digest ? { digest: s.digest } : {}),
            ...(s.confirm ? { confirm: true } : {}),
            ...(s.confirmName ? { confirmName: s.confirmName } : {}),
          },
        });
        if (result.status !== 'ok') return waiting(result, rawLocale);
        const data = result.data;
        if (data.task?.id) {
          const words = followWords(
            s.follow ? s.follow.kind : s.op,
            s.name,
            s.follow ? s.follow.extra : undefined,
            rawLocale,
          );
          if (s.follow !== false)
            followHostTask({
              serverId,
              taskId: data.task.id,
              words,
              platform: s.platform ?? taskPlatform(data.task.id),
            });
          showNotice(words.started);
        } else
          showNotice(
            s.op === 'config.set' && data.changes?.some((c) => c.pending)
              ? mobileTranslator(rawLocale).t('screens2.guest.savedNextRestart', { name: s.name })
              : (s.done ?? manageDoneText(s.op, s.name, false, rawLocale)),
          );
        return { ok: true, result: data };
      } catch (error) {
        const out = refusal(error, rawLocale);
        if (out.conflict) void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.manageRead') });
        return out;
      } finally {
        setBusy(false);
      }
    },
    [change, slug, serverId, qc, rawLocale],
  );
  return { send, busy };
}

export interface ActionSend {
  action: HostGuestAction;
  confirm?: boolean;
  snapshot?: string;
  description?: string;
  memory?: boolean;
}

/**
 * `hosts.guestAction` on one guest: power (its note now, and one later only when it didn't go well) and snapshots
 * (“The snapshot of web started.”, then how it ended).
 */
export function useGuestAction(serverId: string, guest: { id: string; name: string }) {
  const { rawLocale } = useI18n();
  const { slug } = useBurrowBase();
  const change = useHostsChange(api.hosts.guestAction);
  const [busy, setBusy] = useState<string | null>(null);
  const send = useCallback(
    async (a: ActionSend): Promise<ChangeOutcome> => {
      setBusy(a.action);
      try {
        const result = await change.mutateAsync({
          params: { burrow: slug, serverId, guestId: guest.id },
          body: {
            action: a.action,
            ...(a.confirm ? { confirm: true } : {}),
            ...(a.snapshot ? { snapshot: a.snapshot } : {}),
            ...(a.description ? { description: a.description } : {}),
            ...(a.memory ? { memory: true } : {}),
          },
        });
        if (result.status !== 'ok') return waiting(result, rawLocale);
        const snapshot = a.action.startsWith('snapshot_');
        const words = followWords(snapshot ? a.action : 'power', guest.name, a.snapshot, rawLocale);
        if (!result.data.noop)
          followHostTask({
            serverId,
            actionId: result.data.actionId,
            words: snapshot
              ? words
              : {
                  ...words,
                  failed: mobileTranslator(rawLocale).t('screens2.guest.actionFailed', {
                    what: actionAcceptedText(a.action, guest.name, undefined, rawLocale).replace(/\.$/, ''),
                  }),
                },
            quiet: !snapshot,
          });
        showNotice(
          snapshot && !result.data.noop
            ? words.started
            : actionAcceptedText(a.action, guest.name, result.data.noop, rawLocale),
        );
        return { ok: true };
      } catch (error) {
        return refusal(error, rawLocale);
      } finally {
        setBusy(null);
      }
    },
    [change, slug, serverId, guest.id, guest.name, rawLocale],
  );
  return { send, busy };
}
