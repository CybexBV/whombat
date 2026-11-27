/**
 * Automations on the phone, a tab of its own (automations-tab.md AP-6310): what the agent does on its own, an overview
 * rather than an editor (Whombat automation-chat.md; automation-chat-mobile.md). Under the title, what the page is for
 * and “Tell Dusty…”, which starts a new Chat thread. Each automation is one compact row with its mark, whole name and one
 * line of how it is doing (docs/decisions/automations-final.md); a row opens the automation's page (`AutomationScreen`),
 * beside the list with two pages, where it is switched, run, talked about and deleted. The agent's schedules follow under
 * Only tells you, with Pause, Resume and Remove. While it loads, rows without a count; with nothing yet, what will show
 * here; a list that didn't load says so, and one that didn't refresh stays with the time it was read. Schedules that
 * didn't load say so under Only tells you, with Try again, over the rows already read.
 */

import { automationListRows, automationOverview, problemText, SCHEDULE_TEXT } from '@whombat/client';
import { useAgentSchedules, useAutomations } from '@whombat/client/react';
import { formatClock, formatDate } from '@whombat/core';
import { type ReactNode, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { automationListText, onlyTellsYouRows } from '../data/automations';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useAutomationNames } from '../data/useAutomationNames';
import { useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { isBeside, useBeside } from '../navigation/panes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { sendLook } from '../ui/chat';
import { CardLine } from '../ui/facts';
import { Screen } from '../ui/headers';
import { ArrowUp, ChevronDown, ChevronRight, Mic, Paperclip, Zap } from '../ui/icons';
import { Button, ErrorState, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { TabTop } from '../ui/topRow';
import { AutomationListRowView, OnlyTellsYouRowView, ROW_TARGET } from './AutomationRow';
import { useScheduleActions } from './agent/scheduleActions';
import { NewChatSheet } from './NewChatSheet';

/** A finger's target here: 44pt on iOS, 48dp on Android. */
const TARGET = ROW_TARGET;

/** “11:22 on 23 Sep”: when the list on screen was read. */
function savedWhen(at: number, now: Date, timeZone: string): string {
  return `${formatClock(at, timeZone)} on ${formatDate(at, timeZone, { now })}`;
}

export function AutomationsScreen() {
  const { rawLocale } = useI18n();
  const automationListTextHere = automationListText(rawLocale);

  const { t: tMobile } = useMobileT();
  const navigation = useAppNavigation();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const view = useViewContext();
  const agent = useAgentWords();
  const names = useAutomationNames();
  const beside = useBeside();
  const list = useAutomations({ params: { burrow: slug } });
  const schedules = useAgentSchedules({ params: { burrow: slug } });
  const scheduleActions = useScheduleActions(agent.Name);
  // The sheet that starts a Chat thread: empty, or with a question ready (Ask Dusty about a list that didn't load).
  const [telling, setTelling] = useState<{ text: string | null } | null>(null);
  const rows = useMemo(
    () => (list.data ? automationListRows(list.data.automations, view.now, view.timeZone, names) : []),
    [list.data, view.now, view.timeZone, names],
  );
  const told = schedules.data
    ? onlyTellsYouRows(schedules.data.schedules, agent.Name, view.timeZone, view.now)
    : [];
  // “No automations yet” only when both reads worked: schedules that didn't load say so under Only tells you.
  const overview = automationOverview(
    { pending: list.isPending, failed: !!list.error, count: list.data ? rows.length : null },
    {
      pending: schedules.isPending,
      failed: !!schedules.error,
      count: schedules.data ? told.length : null,
    },
  );
  // On an iPhone the list runs on under iOS's tab bar and ends above it.
  const bottomRoom = useBottomRoom();
  const T = automationListTextHere;
  const tell = () => setTelling({ text: null });

  return (
    <Screen>
      <TabTop title={T.automations} />
      <NewChatSheet
        visible={telling !== null}
        onClose={() => setTelling(null)}
        back={tMobile('screens.automations')}
        initialText={telling?.text ?? null}
        words={{
          title: T.tellTitle(agent.Name),
          label: T.tellTitle(agent.Name),
          placeholder: T.tellPlaceholder(agent.Name),
        }}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 16 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => {
              void list.refetch();
              void schedules.refetch();
            }}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View
          style={{
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
            paddingTop: 12,
            paddingBottom: 12,
          }}
        >
          <Text size={15} lh={1.45} color={theme.colors.ink2} style={{ paddingHorizontal: 16 }}>
            {T.intro(agent.Name)}
          </Text>
        </View>
        {list.error ? (
          <ReadProblem
            title={list.data ? T.refreshFailed : T.readFailed}
            text={
              list.data ? T.savedAt(savedWhen(list.dataUpdatedAt, view.now, view.timeZone)) : T.readFailedText
            }
            detail={problemText(list.error, undefined, rawLocale)}
            agent={agent.Name}
            busy={list.isRefetching}
            onRetry={() => void list.refetch()}
            onAsk={() => setTelling({ text: T.askText })}
          />
        ) : null}
        <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 10 }}>
          <Text size={15} lh={1.45} color={theme.colors.ink2}>
            {T.tellIntro(agent.Name)}
          </Text>
          <TellField agent={agent.Name} onPress={tell} />
        </View>
        {overview.body === 'loading' ? (
          <View accessibilityLabel={T.loading}>
            <Text size={13.5} color={theme.colors.ink2} style={{ paddingHorizontal: 16 }}>
              {`${T.loading}…`}
            </Text>
            <SkeletonRows count={4} label={T.loading} />
          </View>
        ) : overview.body === 'unread' ? null : overview.body === 'empty' ? (
          <EmptyList agent={agent.Name} onTell={tell} />
        ) : (
          <>
            {rows.length ? (
              <Group title={T.automations} count={rows.length}>
                {rows.map((row, i) => (
                  <AutomationListRowView
                    key={row.id}
                    row={row}
                    last={i === rows.length - 1}
                    selected={isBeside(beside, 'Automation', 'id', row.id)}
                    onPress={() => navigation.navigate('Automation', { id: row.id })}
                  />
                ))}
              </Group>
            ) : null}
            {overview.schedules !== 'hidden' ? (
              <Group title={T.onlyTellsYou}>
                {overview.schedules === 'failed' ? (
                  <ErrorState text={SCHEDULE_TEXT.loadFailed} onRetry={() => void schedules.refetch()} />
                ) : null}
                <CardLine text={scheduleActions.problem} tone="bad" />
                {told.map((row) => (
                  <OnlyTellsYouRowView
                    key={row.id}
                    row={row}
                    agentName={agent.Name}
                    busy={scheduleActions.busy}
                    onPress={scheduleActions.press}
                  />
                ))}
              </Group>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/** A group of rows under its heading (“Automations 8”, “Only tells you”), in one card. */
function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
      <Text size={19} weight={700} lh={1.3} accessibilityRole="header">
        {title}
        {count !== undefined ? (
          <Text size={13} weight={500} color={theme.colors.ink2}>{`  ${count}`}</Text>
        ) : null}
      </Text>
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** Nothing yet: what will show here, and Tell Dusty…, which opens the field's sheet. */
function EmptyList({ agent, onTell }: { agent: string; onTell: () => void }) {
  const { rawLocale } = useI18n();
  const automationListTextHere = automationListText(rawLocale);

  const theme = useTheme();
  const T = automationListTextHere;
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 12, alignItems: 'flex-start' }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          backgroundColor: theme.colors.sf2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Zap size={22} color={theme.colors.ink2} strokeWidth={1.75} />
      </View>
      <Text size={19} weight={700} accessibilityRole="header">
        {T.emptyTitle}
      </Text>
      <Text size={16} lh={1.5} color={theme.colors.ink2}>
        {T.empty(agent)}
      </Text>
      <Button label={T.emptyButton(agent)} variant="primary" onPress={onTell} style={{ minHeight: TARGET }} />
    </View>
  );
}

/**
 * The list didn't load, or didn't refresh: what happened and what is on screen, Try again (it only reads the list
 * again), Ask Dusty (the question ready in the sheet, unsent) and the error under More detail.
 */
function ReadProblem({
  title,
  text,
  detail,
  agent,
  busy,
  onRetry,
  onAsk,
}: {
  title: string;
  text: string;
  detail: string;
  agent: string;
  busy: boolean;
  onRetry: () => void;
  onAsk: () => void;
}) {
  const { rawLocale } = useI18n();
  const automationListTextHere = automationListText(rawLocale);

  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const T = automationListTextHere;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: 16,
        marginTop: 14,
        padding: 16,
        gap: 10,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={18} weight={700} color={theme.colors.warnText} accessibilityRole="header">
        {title}
      </Text>
      <Text size={14.5} lh={1.45} color={theme.colors.ink2}>
        {text}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          label={T.tryAgain}
          variant="primary"
          busy={busy}
          onPress={onRetry}
          style={{ minHeight: TARGET }}
        />
        <Button label={T.ask(agent)} variant="secondary" onPress={onAsk} style={{ minHeight: TARGET }} />
      </View>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={T.moreDetail}
        style={{ minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: 6 }}
      >
        {open ? (
          <ChevronDown size={16} color={theme.colors.ink2} />
        ) : (
          <ChevronRight size={16} color={theme.colors.ink2} />
        )}
        <Text size={13.5} color={theme.colors.ink2}>
          {T.moreDetail}
        </Text>
      </Touchable>
      {open ? (
        <Text size={13} lh={1.45} color={theme.colors.ink2}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * “Tell Dusty…”: looks like the field it opens (a new Chat thread's sheet). The words shrink, and attach, the mic and the
 * empty send mark keep their own columns at the end, on one row at every text size; the whole field is one target.
 */
function TellField({ agent, onPress }: { agent: string; onPress: () => void }) {
  const { rawLocale } = useI18n();
  const automationListTextHere = automationListText(rawLocale);

  const theme = useTheme();
  const send = sendLook(theme, false);
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={automationListTextHere.tell(agent)}
      accessibilityHint={automationListTextHere.tellHint}
      ringRadius={14}
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 6,
        paddingLeft: 14,
        paddingRight: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={15} color={theme.colors.ink2} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
        {automationListTextHere.tellShort(agent)}
      </Text>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View style={{ width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' }}>
          <Paperclip size={18} color={theme.colors.ink2} strokeWidth={1.9} />
        </View>
        <View style={{ width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' }}>
          <Mic size={18} color={theme.colors.ink2} strokeWidth={1.9} />
        </View>
        {/* Nothing typed yet: the send mark is empty, as the composer's. */}
        <View style={{ width: TARGET, height: TARGET, borderRadius: TARGET / 2, ...send.box }}>
          <ArrowUp size={17} color={send.arrow} strokeWidth={2.25} />
        </View>
      </View>
    </Touchable>
  );
}
