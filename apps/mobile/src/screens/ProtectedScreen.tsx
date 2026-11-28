/**
 * What's protected on the phone (Whombat docs/decisions/backup-trust.md; the web's `/protected`, `whombat://protected`):
 * everything that holds data in three groups — copied to another machine, only on the same machine, not backed up that
 * Whombat can see — each row opening its thing, the last two with *Ask {assistant} to set up backups* in that thing's
 * thread. Under them, Restore tests per Proxmox server: the switch, the last result, the next test, *Test one now* and
 * which machines. Opened from Servers and This Whombat → Backups. The words are `@whombat/core`'s.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useProtectedView, useRunRestoreTest, useSetRestoreTests, useStartChat } from '@whombat/client/react';
import {
  PROTECTED_GROUPS,
  type ProtectedGroup,
  type ProtectedRow,
  protectedAskSubject,
  protectedAskText,
  protectedGroupWords,
  protectedOffsiteLine,
  protectedPageWords,
  protectedRowLine,
  protectedRowOld,
  protectedRowsOf,
  type RestoreTestServer,
  restoreTestLine,
  restoreTestVerdict,
  restoreTestWhen,
} from '@whombat/core';
import { useState } from 'react';
import { RefreshControl, ScrollView, Switch, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { startedChatRoute } from '../data/chatRoom';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { Card } from '../managed/ui';
import { backWordUnder } from '../navigation/backWord';
import { navigateTo, openHref, useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Box, Database, House, Monitor, Server } from '../ui/icons';
import { RowChevron } from '../ui/ListRow';
import { Button, ErrorState, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';

type Props = NativeStackScreenProps<RootStackParamList, 'Protected'>;

const KIND_ICONS = {
  whombat: House,
  server: Server,
  vm: Monitor,
  container: Box,
  service: Database,
} as const;

export function ProtectedScreen({ navigation, route }: Props) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const { slug } = useBurrowBase();
  const words = protectedPageWords(rawLocale);
  const view = useProtectedView({ params: { burrow: slug } }, { refetchInterval: 60_000 });
  const [pulling, setPulling] = useState(false);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const back = (
    <BackBar
      label={route.params?.back ?? backWordUnder(navigation.getState(), route.key, rawLocale)}
      onPress={goBack}
    />
  );
  if (!view.data)
    return (
      <Screen>
        {back}
        <LargeTitle title={words.title} />
        <View style={{ paddingHorizontal: 16 }}>
          {view.isError ? (
            <ErrorState text={words.loadFailed} onRetry={() => void view.refetch()} />
          ) : (
            <SkeletonRows count={6} lines={2} label={words.loading} />
          )}
        </View>
      </Screen>
    );
  const data = view.data;
  const groups = PROTECTED_GROUPS.map((group) => ({ group, rows: protectedRowsOf(data.rows, group) }));
  const count = (g: ProtectedGroup) => groups.find((x) => x.group === g)?.rows.length ?? 0;
  const counts = words.counts(count('copied'), count('local'), count('none'));
  return (
    <Screen>
      {back}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void view.refetch().finally(() => setPulling(false));
            }}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <LargeTitle title={words.title} />
        <View style={{ paddingHorizontal: 16, gap: 18, paddingTop: 4 }}>
          <View style={{ gap: 4, paddingHorizontal: 6 }}>
            <Text size={15} lh={1.45} color={theme.colors.ink2}>
              {words.intro}
            </Text>
            {counts ? (
              <Text size={14} lh={1.45} color={theme.colors.ink2}>
                {counts}
              </Text>
            ) : null}
            {data.unread.length ? (
              <Text size={13.5} lh={1.45} color={theme.colors.mut}>
                {words.unread(data.unread.join(', '))}
              </Text>
            ) : null}
            {data.rows.length ? null : (
              <Text size={14} color={theme.colors.mut}>
                {words.empty}
              </Text>
            )}
          </View>
          {groups.map(({ group, rows }) =>
            rows.length ? <Group key={group} group={group} rows={rows} /> : null,
          )}
          {data.restoreTests.length ? (
            <View style={{ gap: 10 }}>
              <GroupHead title={words.tests} note={words.testsIntro} />
              {data.restoreTests.map((s) => (
                <TestServer key={s.serverId} server={s} single={data.restoreTests.length === 1} />
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function GroupHead({ title, note }: { title: string; note: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4, paddingHorizontal: 6 }}>
      <Text size={11.5} mono color={theme.colors.mut} accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
        {note}
      </Text>
    </View>
  );
}

function Group({ group, rows }: { group: ProtectedGroup; rows: ProtectedRow[] }) {
  const { rawLocale } = useI18n();
  const { title, note } = protectedGroupWords(group, rawLocale);
  return (
    <View style={{ gap: 10 }}>
      <GroupHead title={`${title} · ${rows.length}`} note={note} />
      <Card>
        {rows.map((row, i) => (
          <Row key={row.key} row={row} first={i === 0} ask={group !== 'copied'} />
        ))}
      </Card>
    </View>
  );
}

function Row({ row, first, ask }: { row: ProtectedRow; first: boolean; ask: boolean }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const line = protectedRowLine(row, now, timeZone, rawLocale);
  const lineColor = row.failedAt
    ? theme.colors.bad
    : protectedRowOld(row, now)
      ? theme.colors.warn
      : theme.colors.ink2;
  const test = row.restoreTest ? restoreTestLine(row.restoreTest, now, timeZone, rawLocale) : null;
  const offsite = row.offsite ? protectedOffsiteLine(row.offsite, now, timeZone, rawLocale) : null;
  const Glyph = KIND_ICONS[row.kind];
  const href = row.href;
  const summary = (
    <>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: theme.colors.sf2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Glyph size={18} color={theme.colors.ink2} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <Text size={15.5} weight={600}>
            {row.name}
          </Text>
          {row.on ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {row.on}
            </Text>
          ) : null}
        </View>
        <Text size={13.5} lh={1.4} color={lineColor}>
          {line}
        </Text>
        {offsite ? (
          <Text size={13.5} lh={1.4} color={row.offsite?.failedAt ? theme.colors.warn : theme.colors.ink2}>
            {offsite}
          </Text>
        ) : null}
        {test ? (
          <Text
            size={13.5}
            lh={1.4}
            color={row.restoreTest?.outcome === 'failed' ? theme.colors.bad : theme.colors.ink2}
          >
            {test}
          </Text>
        ) : null}
      </View>
      {href ? <RowChevron /> : null}
    </>
  );
  const rowStyle = { flexDirection: 'row' as const, gap: 12, alignItems: 'flex-start' as const };
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {href ? (
        <Touchable
          onPress={() => openHref(href)}
          feedback="wash"
          accessibilityRole="link"
          accessibilityLabel={[row.name, row.on, line, offsite, test].filter(Boolean).join(', ')}
          style={[rowStyle, { minHeight: 44 }]}
        >
          {summary}
        </Touchable>
      ) : (
        <View style={rowStyle} accessible>
          {summary}
        </View>
      )}
      {ask ? <AskSetUp row={row} /> : null}
    </View>
  );
}

/** *Ask {assistant} to set up backups*: a question about this thing, in its own thread, then that thread. */
function AskSetUp({ row }: { row: ProtectedRow }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const agent = useAgentWords();
  const start = useStartChat(slug);
  const navigation = useAppNavigation();
  const words = protectedPageWords(rawLocale);
  const [failed, setFailed] = useState(false);
  const ask = async () => {
    setFailed(false);
    const subject = protectedAskSubject(row);
    const result = await start
      .mutateAsync({ text: protectedAskText(row, rawLocale), ...(subject ? { subject } : {}) })
      .catch(() => null);
    if (result?.status === 'ok') navigateTo(navigation, startedChatRoute(result.data, words.title));
    else setFailed(true);
  };
  return (
    <View style={{ paddingLeft: 48, gap: 6 }}>
      <Button
        label={words.ask(agent.Name)}
        variant="secondary"
        busy={start.isPending}
        onPress={() => void ask()}
        accessibilityLabel={`${words.ask(agent.Name)}: ${row.name}`}
        wrap
      />
      {failed ? (
        <Text size={13} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {words.failed}
        </Text>
      ) : null}
    </View>
  );
}

function TestServer({ server, single }: { server: RestoreTestServer; single: boolean }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const words = protectedPageWords(rawLocale);
  const set = useSetRestoreTests(slug);
  const run = useRunRestoreTest(slug);
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chosen = server.guests.length ? words.testsSome(server.guests.length) : words.testsAll;
  const busy = set.isPending || run.isPending;
  const save = (on: boolean, guests?: string[]) => {
    setNote(null);
    set.mutate(
      { serverId: server.serverId, on, ...(guests ? { guests } : {}) },
      {
        onSuccess: (r) => setNote(r.status === 'blocked' ? r.message : null),
        onError: () => setNote(words.failed),
      },
    );
  };
  const testNow = () => {
    setNote(null);
    run.mutate(
      { serverId: server.serverId },
      {
        onSuccess: (r) => setNote(r.status === 'blocked' ? r.message : null),
        onError: () => setNote(words.failed),
      },
    );
  };
  const toggle = (guest: string) => {
    const all = server.eligible.map((g) => g.id);
    const current = server.guests.length ? server.guests : all;
    const next = current.includes(guest) ? current.filter((g) => g !== guest) : [...current, guest];
    // Every machine ticked is the same as none chosen: all of them, new ones too.
    save(server.on, next.length === all.length ? [] : next);
  };
  const line = (text: string, color = theme.colors.ink2) => (
    <Text size={14} lh={1.42} color={color}>
      {text}
    </Text>
  );
  const switchLabel = single ? words.testsSwitch : `${words.testsSwitch}: ${server.serverName}`;
  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {single ? null : (
            <Text size={15.5} weight={600}>
              {server.serverName}
            </Text>
          )}
          <Text size={15} weight={single ? 600 : 400}>
            {words.testsSwitch}
          </Text>
          <Text size={13} color={theme.colors.mut}>
            {server.blocked ? words.blocked(server.blocked) : chosen}
          </Text>
        </View>
        <Switch
          value={server.on}
          disabled={busy}
          onValueChange={(on) => save(on)}
          accessibilityLabel={switchLabel}
          accessibilityRole="switch"
          {...switchColors(theme, server.on)}
          style={{ minHeight: 44 }}
        />
      </View>
      <View style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 6 }}>
        {server.running ? line(words.testsRunning(server.running.guestName)) : null}
        {line(
          server.last
            ? `${server.last.guestName}: ${restoreTestVerdict(server.last, now, timeZone, rawLocale)}`
            : words.testsNone,
          server.last?.outcome === 'failed' ? theme.colors.bad : theme.colors.ink2,
        )}
        {server.on && server.next && !server.running
          ? line(words.testsNext(restoreTestWhen(server.next, now, timeZone, rawLocale)))
          : null}
        {note ? line(note, theme.colors.bad) : null}
        <Button
          label={words.testsRun}
          variant="secondary"
          disabled={!!server.running || !!server.blocked}
          busy={run.isPending}
          onPress={testNow}
          style={{ marginTop: 6 }}
        />
      </View>
      {server.eligible.length > 1 ? (
        <Touchable
          onPress={() => setChoosing((c) => !c)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityState={{ expanded: choosing }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 48,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={15} style={{ flex: 1 }}>
            {words.testsChoose}
          </Text>
          <Text size={14} color={theme.colors.mut}>
            {chosen}
          </Text>
          <RowChevron />
        </Touchable>
      ) : null}
      {choosing
        ? server.eligible.map((g) => {
            const on = !server.guests.length || server.guests.includes(g.id);
            // The last one ticked stays: none ticked would mean all of them again.
            const last = server.guests.length === 1 && server.guests[0] === g.id;
            return (
              <View
                key={g.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  minHeight: 48,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text size={15} style={{ flex: 1 }}>
                  {g.name}
                </Text>
                <Switch
                  value={on}
                  disabled={busy || last}
                  onValueChange={() => toggle(g.id)}
                  accessibilityLabel={g.name}
                  accessibilityRole="switch"
                  {...switchColors(theme, on)}
                  style={{ minHeight: 44 }}
                />
              </View>
            );
          })
        : null}
    </Card>
  );
}
