/**
 * “Asks you first” on a server's Summary (Whombat server-asks.md SA-08; server-asks-mobile.md AP-1740…AP-1743): Before
 * risky actions · Never, the hint under it, and on Never on the server this Whombat runs on that restarting or shutting
 * it down still asks. Switching to Never asks first in the app's alert; back needs no question. Saved through
 * `hosts.updateServer {asksFirst}`, then the note “thetitan: Whombat won’t ask first.”. On a Whombat with
 * `hosts.asks`: the parent shows it where `serverAsksRow` gives a row. What the assistant may do lists the same choice
 * per server (`useAsksFirstChoice`).
 */

import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api, HOST_ASKS_FIRST_DEFAULT, type HostAsksFirst } from '@whombat/core';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { serverAsksChange, serverAsksRow } from '../../data/serverAsks';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { Segmented } from '../../ui/Segmented';
import { showNotice } from '../feedback';

/**
 * One server's choice, saved through `hosts.updateServer {asksFirst}`: `value` shows the new choice at once while it
 * saves, and `choose` asks before Go ahead, then says what changed (or why it didn't).
 */
export function useAsksFirstChoice(
  serverId: string,
  serverName: string,
  asksFirst: HostAsksFirst | null | undefined,
): { value: HostAsksFirst; choose: (to: HostAsksFirst) => void } {
  const { rawLocale } = useI18n();

  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const change = useHostsChange(api.hosts.updateServer);
  // The choice shows at once while it saves, until the server's page has it (no flicker back while it refetches).
  const [saving, setSaving] = useState<HostAsksFirst | null>(null);
  const current = asksFirst ?? HOST_ASKS_FIRST_DEFAULT;
  useEffect(() => {
    if (saving === current) setSaving(null);
  }, [saving, current]);

  const save = (to: HostAsksFirst, toast: string) => {
    setSaving(to);
    change.mutate(
      { params: { burrow: slug, serverId }, body: { asksFirst: to } },
      {
        onSuccess: (result) => {
          const text = commitOutcomeText(result, rawLocale);
          if (!text) return showNotice(toast);
          setSaving(null);
          Alert.alert(tMobile('screens.not-yet'), text);
        },
        onError: (error) => {
          setSaving(null);
          Alert.alert(tMobile('managed.that-didnt-go-through'), hostErrorInfo(error, rawLocale).message);
        },
      },
    );
  };

  const choose = (to: HostAsksFirst) => {
    if (saving) return;
    const step = serverAsksChange(serverName, current, to, rawLocale);
    if (!step) return;
    if (!step.confirm) return save(to, step.toast);
    Alert.alert(step.confirm.title, step.confirm.body, [
      { text: step.confirm.cancel, style: 'cancel' },
      { text: step.confirm.confirm, style: 'destructive', onPress: () => save(to, step.toast) },
    ]);
  };
  return { value: saving ?? current, choose };
}

export function AsksFirstCard({
  serverId,
  serverName,
  asksFirst,
  hostsThisWhombat,
}: {
  serverId: string;
  serverName: string;
  asksFirst: HostAsksFirst | null | undefined;
  hostsThisWhombat: boolean | null | undefined;
}) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { value, choose } = useAsksFirstChoice(serverId, serverName, asksFirst);
  const row = serverAsksRow({
    server: serverName,
    asksFirst: value,
    hostsThisWhombat,
    available: true,
    locale: rawLocale,
  });
  if (!row) return null;
  return (
    <OneCard label={row.label}>
      <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 14 }}>
        <Segmented<HostAsksFirst>
          label={row.accessibilityLabel}
          value={row.value}
          onChange={choose}
          options={row.options}
        />
        <Text size={13} lh={1.4} color={theme.colors.mut} accessibilityLiveRegion="polite">
          {row.selfNote ? `${row.hint} ${row.selfNote}` : row.hint}
        </Text>
      </View>
    </OneCard>
  );
}
