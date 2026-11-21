/**
 * A server's operating-system updates on the phone (Whombat server-updates.md SWU-04…SWU-12; server-updates-app.md
 * AP-2880…AP-2886), the web's words: the Updates line with when the list was read, how the last task ended, then
 * Install updates (asked first: “Install 4 updates on pve-02?”), Check now, or — while the server runs one, also one
 * started on another device — Show log (its sheet follows the log; a check can be stopped, an install can't); without
 * Full control it says why. RESTART when one is needed, with Restart now (the server's power question). WAITING:
 * the packages, security first, each now → new (Look inside's list, so read-only checks must be on). A started task is
 * followed until it ends (`HostTasksBridge`). `whombat://things/server%3Apve-02/updates`.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  hostErrorInfo,
  hostPowerBody,
  hostsThisWhombat,
  packageOpOf,
  packageRows,
  packageTaskOutcomeText,
  UPDATES_WORDS,
} from '@whombat/client/hosts';
import {
  useHostInspect,
  useHostServer,
  useHostsChange,
  useHostsLive,
  useRefreshHosts,
} from '@whombat/client/hosts/react';
import { api, type HostTask } from '@whombat/core';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Dot, OneCard, OneRow, ToneBadge, toneOf } from '../ui/assistant';
import { BackBar, Screen } from '../ui/headers';
import { OneSheet } from '../ui/oneSheet';
import { Button, ErrorState, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { showNotice } from './feedback';
import { TaskSheet } from './guest/GuestTasks';
import { CardQuiet } from './guest/parts';
import { useManageChange } from './guest/useServerChange';
import { useServerUpdatesView } from './server/Updates';

type Props = NativeStackScreenProps<RootStackParamList, 'ServerUpdates'>;

const INSET = 18;

export function ServerUpdatesScreen({ route, navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const { serverId, title, back } = route.params;
  const theme = useTheme();
  const { slug, currentBootstrap } = useBurrowBase();
  useHostsLive(currentBootstrap().burrow.id);
  // While a package task runs the page is read again now and then, so its end shows without a pull.
  const q = useHostServer(
    { params: { burrow: slug, serverId } },
    {
      retry: false,
      refetchInterval: (query) => (query.state.data?.health?.system?.packageTask ? 5000 : false),
    },
  );
  const d = q.data ?? null;
  // The name a person gave it, else its id.
  const name = d ? (d.server.name ?? d.server.id) : (title ?? serverId);
  const view = useServerUpdatesView(d, name);
  const running = view?.running ?? null;
  const rc = d?.server.remoteControl;
  // The waiting packages are Look inside's list (read-only checks, as on the web).
  const lookOk = rc?.diagnose !== false;
  const list = useHostInspect(
    d && view?.available && lookOk ? { params: { burrow: slug, serverId, kind: 'updates' } } : null,
    { retry: false, staleTime: 15_000 },
  );
  // A package task ended (here or elsewhere): the list is read again (SWU-05).
  const ended = d?.health?.system?.packageLast?.finishedAt ?? null;
  const refresh = useRefreshHosts();
  useEffect(() => {
    if (ended) refresh(['hosts.inspect']);
  }, [ended, refresh]);
  const { send, busy } = useManageChange(serverId);
  const restart = useHostsChange(api.hosts.serverAction);
  const [sheet, setSheet] = useState<'install' | 'restart' | null>(null);
  // The log's sheet keeps its task once opened, so it says how it ended when the page no longer reports it running.
  const [log, setLog] = useState<HostTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const close = () => {
    setSheet(null);
    setError(null);
  };

  const start = async (op: 'install' | 'check') => {
    const out = await send({
      op: op === 'install' ? 'packages.install' : 'packages.check',
      platform: 'host',
      ...(op === 'install' ? { confirm: true } : {}),
      name,
    });
    if (out.ok) {
      close();
      void list.refetch();
    } else if (out.waiting) close();
    else if (op === 'install') setError(out.message);
    else Alert.alert('That didn’t go through', out.message);
  };

  const reboot = () => {
    setError(null);
    restart.mutate(
      { params: { burrow: slug, serverId }, body: { action: 'host_reboot', confirm: true } },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') return close();
          close();
          showNotice(`Restarting ${name}.`);
        },
        onError: (e) => setError(hostErrorInfo(e).message),
      },
    );
  };

  const rows = list.data?.kind === 'updates' ? packageRows(list.data.items) : [];
  const showLog = () => {
    const t = d?.health?.system?.packageTask;
    if (running && t)
      setLog({ id: running.taskId, type: `packages.${running.op}`, started: t.startedAt, status: 'running' });
  };

  return (
    <Screen>
      <BackBar label={back ?? name} onPress={goBack} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: INSET, paddingBottom: 24 + bottomRoom, gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void Promise.all([q.refetch(), list.refetch()]).finally(() => setPulling(false));
            }}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View
          style={{ gap: 6 }}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${UPDATES_WORDS.title} on ${name}`}
        >
          <Text size={28} weight={700} tracking={-0.02}>
            {UPDATES_WORDS.title}
          </Text>
          <Text size={13} mono color={theme.colors.mut} numberOfLines={1}>
            {name}
          </Text>
        </View>
        {!d ? (
          q.isError ? (
            <ErrorState text="This server didn’t load." onRetry={() => void q.refetch()} />
          ) : (
            <SkeletonRows count={4} lines={2} label="Loading the updates" />
          )
        ) : !view?.available ? (
          <CardQuiet>{UPDATES_WORDS.noReport}</CardQuiet>
        ) : (
          <>
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Dot tone={view.line.tone === 'mut' ? null : view.line.tone} />
                <Text size={16} weight={500} style={{ flexShrink: 1 }}>
                  {view.line.text}
                </Text>
              </View>
              {view.line.checked ? (
                <Text size={12.5} mono color={theme.colors.mut}>
                  {view.line.checked}
                </Text>
              ) : null}
              {view.result ? (
                <Text
                  size={14}
                  lh={1.45}
                  color={view.result.tone === 'bad' ? toneOf(theme, 'bad') : theme.colors.ink2}
                >
                  {`${view.result.text.replace(/\.$/, '')} · ${view.result.when}`}
                </Text>
              ) : null}
              {view.note ? (
                <Text size={14} lh={1.45} color={theme.colors.ink2}>
                  {view.note}
                </Text>
              ) : null}
            </View>
            {view.running || view.install || view.check ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {view.running ? (
                  <Button label={UPDATES_WORDS.showLog} variant="secondary" onPress={showLog} />
                ) : null}
                {view.install ? (
                  <Button
                    label={UPDATES_WORDS.install}
                    variant="primary"
                    disabled={busy}
                    onPress={() => setSheet('install')}
                  />
                ) : null}
                {view.check ? (
                  <Button
                    label={UPDATES_WORDS.check}
                    variant="secondary"
                    busy={busy && sheet === null}
                    disabled={busy}
                    onPress={() => void start('check')}
                  />
                ) : null}
              </View>
            ) : null}
            {view.restart.tone === 'warn' ? (
              <OneCard label={UPDATES_WORDS.restartTitle}>
                <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Dot tone="warn" />
                    <Text size={15} lh={1.45} style={{ flexShrink: 1 }}>
                      {view.restart.text}
                    </Text>
                  </View>
                  {view.restart.button ? (
                    <Button
                      label={UPDATES_WORDS.restartNow}
                      variant="secondary"
                      onPress={() => setSheet('restart')}
                    />
                  ) : null}
                </View>
              </OneCard>
            ) : null}
            <OneCard label={rows.length ? `Waiting · ${rows.length}` : 'Waiting'}>
              {!lookOk ? (
                <CardQuiet>
                  {rc?.diagnoseReason ?? 'Read-only checks are switched off for this server.'}
                </CardQuiet>
              ) : list.isPending ? (
                <SkeletonRows count={3} lines={2} label="Loading the packages" />
              ) : list.isError ? (
                <CardQuiet>{hostErrorInfo(list.error).message}</CardQuiet>
              ) : rows.length ? (
                rows.map((r) => (
                  <OneRow
                    key={r.name}
                    title={r.name}
                    titleMono
                    meta={r.versions}
                    badge={r.security ? <ToneBadge text="security" tone="warn" /> : undefined}
                    label={r.label}
                  />
                ))
              ) : (
                <CardQuiet>{UPDATES_WORDS.nothingWaiting}</CardQuiet>
              )}
            </OneCard>
          </>
        )}
      </ScrollView>
      {sheet === 'install' && view ? (
        <OneSheet
          visible
          onClose={() => !busy && close()}
          badge={name}
          tone="warn"
          title={UPDATES_WORDS.confirmTitle(view.count, name)}
          body={UPDATES_WORDS.confirmBody(name)}
          busy={busy ? 'install' : null}
          buttons={[
            {
              id: 'install',
              label: UPDATES_WORDS.install,
              variant: 'primary',
              onPress: () => void start('install'),
            },
            { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: close },
          ]}
          note={error}
        />
      ) : null}
      {sheet === 'restart' ? (
        <OneSheet
          visible
          onClose={() => !restart.isPending && close()}
          badge={name}
          tone="bad"
          title={`Restart ${name}?`}
          body={hostPowerBody('host_reboot', hostsThisWhombat(d?.server))}
          busy={restart.isPending ? 'restart' : null}
          buttons={[
            { id: 'restart', label: 'Restart', variant: 'primary', onPress: reboot },
            { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: close },
          ]}
          note={error}
        />
      ) : null}
      {log ? (
        <TaskSheet
          slug={slug}
          serverId={serverId}
          task={log}
          canStop={view?.may === true}
          title={UPDATES_WORDS.what(packageOpOf(log.type) ?? 'install', name)}
          body={(t) => {
            const op = packageOpOf(t.type) ?? packageOpOf(log.type) ?? 'install';
            if (t.status === 'running') return UPDATES_WORDS.running[op];
            if (t.code === 'busy') return UPDATES_WORDS.busy(name);
            return packageTaskOutcomeText(op, t.packages, name);
          }}
          onClose={() => setLog(null)}
        />
      ) : null}
    </Screen>
  );
}
