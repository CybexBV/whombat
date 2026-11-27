/**
 * “Keep server agents up to date” on the phone (Whombat agent-updates.md AU-05, AU-06; agent-updates-app.md AP-2992):
 * the web's switch, in This Whombat → About's UPDATES card on a managed Whombat, or a card of its own on This Whombat
 * of a self-hosted server and the demo world. Stopped after a version didn't come back on a server, its words say so
 * beside an amber dot.
 * Only on a Whombat with `hosts.agent_updates`. Saved at once, with a note.
 */

import { agentSettingsView, agentUpdateWords, commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { useHostAgentSettings, useHostsChange, useHostsStatus } from '@whombat/client/hosts/react';
import { MANAGED_TEXT } from '@whombat/client/managed';
import { api } from '@whombat/core';
import { Alert, Switch, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n, useMobileT } from '../i18n';
import { Card } from '../managed/ui';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { StatusDot } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';

function useAgentSettings() {
  const { slug } = useBurrowBase();
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const settings = useHostAgentSettings(status.data?.present ? { params: { burrow: slug } } : null, {
    retry: false,
  });
  return { slug, settings: settings.data ?? null };
}

/** The switch's row, inside a card; null where it doesn't show. */
export function AgentUpdatesSwitchRow({ first = false }: { first?: boolean }) {
  const { rawLocale } = useI18n();
  const agentUpdateWordsHere = agentUpdateWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug, settings } = useAgentSettings();
  const change = useHostsChange(api.hosts.updateAgentSettings);
  if (!settings) return null;
  const v = agentSettingsView(settings, rawLocale);
  const failed = (text: string) => Alert.alert(tMobile('managed.that-didnt-go-through'), text);
  const save = (autoUpdate: boolean) =>
    change.mutate(
      { params: { burrow: slug }, body: { autoUpdate } },
      {
        onSuccess: (r) =>
          r.status === 'ok'
            ? showNotice(agentUpdateWordsHere.switched(autoUpdate))
            : failed(commitOutcomeText(r, rawLocale) ?? ''),
        onError: (error) => failed(hostErrorInfo(error, rawLocale).message),
      },
    );
  const meta = v.meta;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {v.tone === 'warn' ? <StatusDot color={theme.colors.warn} label={v.meta} /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600}>
          {v.title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {meta}
        </Text>
      </View>
      <Switch
        value={change.isPending && change.variables ? change.variables.body.autoUpdate : v.on}
        disabled={change.isPending}
        onValueChange={save}
        accessibilityLabel={v.title}
        accessibilityHint={meta}
        accessibilityRole="switch"
        {...switchColors(theme, v.on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}

/** UPDATES with the switch alone (This Whombat of a self-hosted server or the demo world). */
export function AgentUpdatesSwitchCard() {
  const { settings } = useAgentSettings();
  if (!settings) return null;
  return (
    <Card label={MANAGED_TEXT.updates}>
      <AgentUpdatesSwitchRow first />
    </Card>
  );
}
