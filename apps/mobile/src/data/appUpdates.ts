/**
 * Docker Compose app updates on the phone (Whombat app-updates.md): whether this Whombat updates apps (session minor
 * 22; an older box sends none, and its servers' helpers aren't what is old), and Update, which asks through the
 * approval card and opens it. Nothing runs before the yes.
 */
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { useSessionProtocol } from '@whombat/client/react';
import { api } from '@whombat/core';
import { APP_UPDATES_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useCallback, useState } from 'react';
import { useI18n } from '../i18n';
import { useBurrowBase } from './BurrowProvider';

export function useAppUpdatesOn(): boolean {
  const protocol = useSessionProtocol();
  return protocol === null || protocolAtLeast(protocol, APP_UPDATES_MINOR);
}

/** Asks to update apps; the approval card's number, or the refusal's words. */
export function useAppUpdate(serverId: string) {
  const { rawLocale } = useI18n();
  const { slug } = useBurrowBase();
  const change = useHostsChange(api.hosts.manage);
  const [busy, setBusy] = useState(false);
  const ask = useCallback(
    async (apps: string[]): Promise<{ approval: number } | { error: string }> => {
      setBusy(true);
      try {
        const result = await change.mutateAsync({
          params: { burrow: slug, serverId },
          body: { op: 'app.update', platform: 'host', params: { apps } },
        });
        if (result.status !== 'ok') return { error: commitOutcomeText(result, rawLocale) ?? '' };
        const n = result.data.approvalNumber;
        return n != null ? { approval: n } : { error: '' };
      } catch (error) {
        return { error: hostErrorInfo(error, rawLocale).message };
      } finally {
        setBusy(false);
      }
    },
    [change, slug, serverId, rawLocale],
  );
  return { ask, busy };
}
