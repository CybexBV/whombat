/**
 * How a server's agent keeps up to date, on its Summary (Whombat agent-updates.md AU-07, AU-08; agent-updates-app.md
 * AP-2991…AP-2993): the web's Updates row in an AGENT card — kept up to date, updating, waiting, couldn't, needs one
 * more install, turned off on the server, automatic updates off — with Try again, Update the agent or Update now
 * (`hosts.updateAgent`), or “Show the install command” where Whombat may not run the last install itself (the command
 * to copy, as the web's). On a Whombat with `hosts.agent_updates`; `agentUpdatesView` decides. The server's
 * settings are read every few seconds while its agent updates.
 */

import {
  AGENT_UPDATE_POLL_MS,
  agentUpdatesView,
  agentUpdateWords,
  agentUpdating,
  commandCopy,
  commitOutcomeText,
  hostErrorInfo,
  updateCommand,
} from '@whombat/client/hosts';
import {
  useHostAgentSettings,
  useHostServerSettings,
  useHostsChange,
  useRefreshHosts,
} from '@whombat/client/hosts/react';
import { api, type HostServerDetail } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard, OneRow } from '../../ui/assistant';
import { copyToClipboard } from '../../ui/clipboard';
import { Button } from '../../ui/primitives';
import { showNotice } from '../feedback';

export function AgentUpdatesCard({
  serverId,
  serverName,
  detail,
}: {
  serverId: string;
  serverName: string;
  detail: HostServerDetail;
}) {
  const { rawLocale } = useI18n();
  const commandCopyHere = commandCopy(rawLocale);
  const agentUpdateWordsHere = agentUpdateWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const settings = useHostServerSettings(
    { params: { burrow: slug, serverId } },
    {
      retry: false,
      refetchInterval: (q) => (agentUpdating(q.state.data?.agent?.update) ? AGENT_UPDATE_POLL_MS : false),
    },
  );
  const auto = useHostAgentSettings({ params: { burrow: slug } }, { retry: false });
  const update = useHostsChange(api.hosts.updateAgent);
  const create = useHostsChange(api.hosts.createEnrollment);
  const [command, setCommand] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  // When its update ends, the server's page (the agent's version) is read again.
  const refresh = useRefreshHosts();
  const nowUpdating = agentUpdating(settings.data?.agent?.update);
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (wasUpdating.current && !nowUpdating) refresh(['hosts.getServer', 'hosts.fleet']);
    wasUpdating.current = nowUpdating;
  }, [nowUpdating, refresh]);

  const view = agentUpdatesView({
    server: serverName,
    update: settings.data?.agent?.update,
    autoUpdate: auto.data?.autoUpdate ?? null,
    connected: detail.server.agent.connected !== false && detail.server.status !== 'offline',
    now: Date.parse(detail.asOf),
    locale: rawLocale,
  });
  if (!view) return null;
  const W = agentUpdateWordsHere;

  const failed = (text: string) => Alert.alert(tMobile('managed.that-didnt-go-through'), text);
  const press = () =>
    update.mutate(
      { params: { burrow: slug, serverId } },
      {
        onSuccess: (r) =>
          r.status === 'ok'
            ? showNotice(W.started(r.data.state, serverName))
            : failed(commitOutcomeText(r, rawLocale) ?? ''),
        onError: (error) => failed(hostErrorInfo(error, rawLocale).message),
      },
    );
  const show = () => {
    setMaking(true);
    create
      .mutateAsync({ params: { burrow: slug } })
      .then(
        (r) =>
          r.status === 'ok'
            ? setCommand(updateCommand(r.data.installCommand, settings.data?.agent?.install))
            : failed(commitOutcomeText(r, rawLocale) ?? ''),
        (error: unknown) => failed(hostErrorInfo(error, rawLocale).message),
      )
      .finally(() => setMaking(false));
  };

  return (
    <OneCard label={tMobile('screens2.server.helper')}>
      <OneRow
        first
        leading={<Dot tone={view.tone === 'mut' ? null : view.tone} />}
        title={W.title}
        line={view.text}
        meta={view.updated}
        label={`${W.title}: ${view.text}${view.updated ? `, ${view.updated}` : ''}`}
      />
      {view.action || view.command ? (
        <View style={{ gap: 10, paddingHorizontal: 14, paddingBottom: 14 }}>
          {view.action ? (
            <Button
              label={view.action.label}
              variant={view.action.kind === 'install' ? 'primary' : 'secondary'}
              busy={update.isPending}
              onPress={press}
            />
          ) : null}
          {view.command && command ? (
            <>
              <View style={{ backgroundColor: theme.colors.code, borderRadius: 10, padding: 12 }}>
                <Text size={12.5} lh={1.55} mono color={theme.code.text} selectable>
                  {command}
                </Text>
              </View>
              <Text size={13} lh={1.4} color={theme.colors.mut}>
                {W.commandNote}
              </Text>
              <Button
                label={commandCopyHere.copy}
                variant="secondary"
                onPress={() => void copyToClipboard(command, commandCopyHere.copied, rawLocale)}
              />
            </>
          ) : view.command ? (
            <Button
              label={making ? W.making : W.showCommand}
              variant="secondary"
              busy={making}
              onPress={show}
            />
          ) : null}
        </View>
      ) : null}
    </OneCard>
  );
}
