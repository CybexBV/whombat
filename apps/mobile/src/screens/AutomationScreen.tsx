/**
 * One automation's page (docs/app/decisions/automation-page.md AP-6331…AP-6335): its tile and whole name, On or Off with
 * the switch, the agent's sentence of what it is for, Try it (or Run now) and Talk about it, then what happens step by
 * step (core `automationFlow`: what starts it, each step with what it reaches outside Whombat, the checks between them),
 * what it asks first, its limits, its recent runs, what the agent is asked word for word (folded) and Delete. Opened
 * from the Automations list, beside it with two pages. Switching, running and deleting never ask the agent.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  type AutomationState,
  automationPage,
  automationRunRows,
  runBars,
  talkAboutText,
} from '@whombat/client';
import { useApiMutation, useAutomation, useAutomationRuns, useAutomations } from '@whombat/client/react';
import type { AutomationFlowItem, AutomationPlanLine } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type ReactNode, useState } from 'react';
import { Alert, Platform, RefreshControl, ScrollView, Switch, View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import { automationDeleteText, automationGone, automationListText } from '../data/automations';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useAutomationNames } from '../data/useAutomationNames';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tagColors } from '../ui/glanceColors';
import { BackBar, Screen } from '../ui/headers';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  FileText,
  GitMerge,
  GitPullRequest,
  Hand,
  LinkIcon,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Reply,
  Zap,
} from '../ui/icons';
import { Button, ErrorState, SectionLabel, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { RunBars, SourceTile, StateDot, WaitingLine } from './AutomationRow';
import { errorText, outcomeText } from './feedback';
import { NewChatSheet } from './NewChatSheet';
import { useStartAutomation } from './useStartAutomation';

type Props = NativeStackScreenProps<RootStackParamList, 'Automation'>;

const ICONS: Record<Exclude<Extract<AutomationFlowItem, { kind: 'step' }>['icon'], 'agent'>, LucideIcon> = {
  start: Zap,
  post: MessageSquare,
  ask: Hand,
  wait: Clock,
  pull_request: GitPullRequest,
  merge: GitMerge,
  comment: MessageCircle,
  report: FileText,
  reply: Reply,
  call: LinkIcon,
};

const MARK_TONES = { plain: 'plain', changes: 'warn', merges: 'bad' } as const;

export function AutomationScreen({ navigation, route }: Props) {
  const { rawLocale, tClient } = useI18n();
  const automationDeleteTextHere = automationDeleteText(rawLocale);
  const automationListTextHere = automationListText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, viewer } = useBurrowBase();
  const view = useViewContext();
  const agent = useAgentWords();
  const names = useAutomationNames();
  const { id } = route.params;
  const list = useAutomations({ params: { burrow: slug } });
  const detail = useAutomation({ params: { burrow: slug, id } }, { retry: false });
  const runs = useAutomationRuns({ params: { burrow: slug }, query: { automation: id, limit: 10 } });
  const setEnabled = useApiMutation(api.automations.setEnabled);
  const remove = useApiMutation(api.automations.delete);
  const { start } = useStartAutomation();
  const [switching, setSwitching] = useState(false);
  const [starting, setStarting] = useState(false);
  // Which automation the new-thread sheet and the open fold are for: with two pages another one opens in this same
  // page, and it starts with neither.
  const [tellingFor, setTellingFor] = useState<string | null>(null);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const telling = tellingFor === id;
  const asked = askedFor === id;

  const automation = detail.data?.automation ?? list.data?.automations.find((a) => a.id === id) ?? null;
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Automations' });
  const refresh = () => {
    void detail.refetch();
    void list.refetch();
    void runs.refetch();
  };

  const back = <BackBar label={route.params.back ?? tMobile('screens.automations')} onPress={goBack} />;
  const gone = automationGone(detail.data, detail.error);
  if (!automation || automation.deletedAt)
    return (
      <Screen>
        {back}
        {detail.isPending && !gone ? (
          <SkeletonRows count={4} lines={2} label={tMobile('screens.loading-the-automation')} />
        ) : (
          <ErrorState
            text={gone ? tClient('automations.notFound') : tClient('automations.failed')}
            onRetry={gone ? undefined : refresh}
          />
        )}
      </Screen>
    );

  const page = automationPage(automation, {
    now: view.now,
    timeZone: view.timeZone,
    names,
    viewer,
    deletes: true,
  });
  const runRows = automationRunRows(runs.data?.runs ?? [], view.now, view.timeZone);

  const toggle = (enabled: boolean) => {
    setSwitching(true);
    setEnabled.mutate(
      { params: { burrow: slug, id }, body: { enabled } },
      {
        onSuccess: (res) => {
          const text = outcomeText(res);
          if (text) Alert.alert(text.title, text.body);
          refresh();
        },
        onError: (err) => Alert.alert(tMobile('screens.didnt-switch'), errorText(err)),
        onSettled: () => setSwitching(false),
      },
    );
  };

  const run = () => {
    if (!page.run) return;
    setStarting(true);
    void start(id, { test: page.run.kind === 'try', tryIt: page.run.tryIt }).then((outcome) => {
      setStarting(false);
      if (!outcome.ok) return Alert.alert(tMobile('screens.didnt-start'), outcome.text);
      void runs.refetch();
      navigation.navigate('AutomationRun', { number: outcome.runNumber, back: page.name });
    });
  };

  /** The thread of its latest plan, else a new thread about it with “About “Name”: ” ready to finish. */
  const talk = () => {
    if (automation.talk)
      navigation.navigate('Thread', { messageId: automation.talk.threadRootId, back: page.name });
    else setTellingFor(id);
  };

  const deleteIt = () =>
    remove.mutate(
      { params: { burrow: slug, id } },
      {
        onSuccess: (res) => {
          const text = outcomeText(res);
          if (text) return Alert.alert(text.title, text.body);
          void list.refetch();
          goBack();
        },
        onError: (err) => {
          // Someone deleted it first: it is gone all the same.
          if (automationGone(undefined, err)) {
            void list.refetch();
            return goBack();
          }
          Alert.alert(automationDeleteTextHere.failed, errorText(err));
        },
      },
    );
  const confirmDelete = () =>
    Alert.alert(automationDeleteTextHere.confirmTitle(page.name), automationDeleteTextHere.confirmBody, [
      { text: automationDeleteTextHere.cancel, style: 'cancel' },
      { text: automationDeleteTextHere.delete, style: 'destructive', onPress: deleteIt },
    ]);

  const waiting = page.state.tone === 'waiting';
  return (
    <Screen>
      {back}
      <NewChatSheet
        visible={telling}
        onClose={() => setTellingFor(null)}
        back={page.name}
        initialText={talkAboutText(page.name)}
        words={{
          title: automationListTextHere.tellTitle(agent.Name),
          label: automationListTextHere.tellTitle(agent.Name),
          placeholder: automationListTextHere.tellPlaceholder(agent.Name),
        }}
      />
      <ScrollView
        key={id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={detail.isRefetching || runs.isRefetching}
            onRefresh={refresh}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 14,
            paddingHorizontal: 20,
            paddingTop: 4,
          }}
        >
          <SourceTile tile={page.tile} size={52} />
          <Text
            size={24}
            weight={700}
            lh={1.2}
            tracking={-0.015}
            accessibilityRole="header"
            style={{ flex: 1, paddingTop: 2 }}
          >
            {page.name}
          </Text>
        </View>

        <View
          style={{
            marginHorizontal: 20,
            marginTop: 14,
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }} accessible>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                <StateDot tone={page.state.runs} />
                <Text size={15} weight={600} color={theme.colors.ink}>
                  {page.state.label}
                </Text>
              </View>
              {stateLines(page.state, waiting).map((l) => (
                <Text key={l} size={13} lh={1.35} color={theme.colors.ink2}>
                  {l}
                </Text>
              ))}
            </View>
            {page.switch ? (
              <View style={{ minHeight: 44, justifyContent: 'center' }}>
                <Switch
                  value={page.switch.on}
                  disabled={switching}
                  onValueChange={toggle}
                  accessibilityLabel={page.name}
                  accessibilityRole="switch"
                  {...switchColors(theme, page.switch.on)}
                  // iOS draws its switch at the top of a taller frame: the 44dp box around it centres it there.
                  style={Platform.OS === 'android' ? { minHeight: 44 } : undefined}
                />
              </View>
            ) : null}
          </View>
          {waiting ? (
            <WaitingLine
              indent={false}
              waiting={{
                text: page.state.line,
                accessibilityLabel: `${page.state.line} ${automationListTextHere.open}.`,
              }}
              onOpen={() => {
                const number = page.state.waitingRun;
                if (number) navigation.navigate('AutomationRun', { number, back: page.name });
                else talk();
              }}
            />
          ) : null}
        </View>

        {page.description ? (
          <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ marginHorizontal: 20, marginTop: 14 }}>
            {page.description}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 20, marginTop: 14 }}>
          {page.run ? (
            <Button
              label={tClient(`automations.action.${page.run.kind}`)}
              variant="primary"
              busy={starting}
              accessibilityHint={tClient(
                page.run.kind === 'run' ? 'automations.action.runHint' : 'automations.action.tryHint',
                { name: page.name },
              )}
              onPress={run}
              style={{ flex: 1 }}
            />
          ) : null}
          <Button
            label={tClient('automations.action.talk')}
            variant="secondary"
            accessibilityHint={page.talkHint}
            onPress={talk}
            style={{ flex: 1 }}
          />
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 18 }}>
          <SectionLabel>{tClient('automations.whatHappens')}</SectionLabel>
          {page.flow ? (
            <Flow items={page.flow} agentId={view.people.agent?.id ?? null} />
          ) : (
            <Text size={15} lh={1.5} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
              {page.summary}
            </Text>
          )}
        </View>

        {page.asks.length ? <Lines title={tClient('automations.asks')} lines={page.asks} /> : null}
        {page.limits.length ? <Lines title={tClient('automations.limits')} lines={page.limits} /> : null}

        {runRows.length ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <SectionLabel>{tClient('automations.runs')}</SectionLabel>
              {/* The last few as small bars, oldest left; each run says its result in words. */}
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ marginBottom: 8 }}
              >
                <RunBars bars={runBars(runs.data?.runs ?? []).bars} />
              </View>
            </View>
            <Card>
              {runRows.map((r, i) => (
                <Touchable
                  key={r.number}
                  onPress={() => navigation.navigate('AutomationRun', { number: r.number, back: page.name })}
                  feedback="wash"
                  accessibilityRole="button"
                  accessibilityLabel={r.accessibilityLabel}
                  style={[rowStyle(theme, i === runRows.length - 1), { gap: 10 }]}
                >
                  <View
                    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneOf(theme, r.tone) }}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text size={14} lh={1.35} color={theme.colors.ink2} numberOfLines={2}>
                      {r.title}
                    </Text>
                    <Text size={12.5} lh={1.35} color={theme.colors.ink2}>
                      {`${r.result} · ${r.when}`}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.8} />
                </Touchable>
              ))}
            </Card>
          </View>
        ) : null}

        {page.prompts.length ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
            <Card>
              <Touchable
                onPress={() => setAskedFor(asked ? null : id)}
                feedback="wash"
                accessibilityRole="button"
                accessibilityState={{ expanded: asked }}
                style={[rowStyle(theme, !asked), { gap: 10 }]}
              >
                <Text size={14} color={theme.colors.ink2} style={{ flex: 1 }}>
                  {tClient('automations.prompts', { agent: agent.Name })}
                </Text>
                <Text size={12.5} color={theme.colors.mut}>
                  {tClient('automations.promptsCount', { count: page.prompts.length })}
                </Text>
                {asked ? (
                  <ChevronUp size={16} color={theme.colors.mut} strokeWidth={1.8} />
                ) : (
                  <ChevronDown size={16} color={theme.colors.mut} strokeWidth={1.8} />
                )}
              </Touchable>
              {asked
                ? page.prompts.map((p, i) => (
                    <View
                      key={p.step}
                      style={[
                        rowStyle(theme, i === page.prompts.length - 1),
                        { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 },
                      ]}
                    >
                      <Text size={13} weight={600} color={theme.colors.ink}>
                        {p.step}
                      </Text>
                      <Text size={13} lh={1.45} color={theme.colors.ink2} selectable>
                        {p.text}
                      </Text>
                    </View>
                  ))
                : null}
            </Card>
          </View>
        ) : null}

        {page.canDelete ? (
          <Touchable
            onPress={confirmDelete}
            feedback="fade"
            accessibilityRole="button"
            accessibilityHint={automationDeleteTextHere.deleteHint(page.name)}
            style={{
              marginHorizontal: 20,
              marginTop: 18,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text size={15} weight={600} color={theme.colors.bad}>
              {tClient('automations.delete')}
            </Text>
          </Touchable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function toneOf(theme: ReturnType<typeof useTheme>, tone: string): string {
  if (tone === 'ok') return theme.colors.ok;
  if (tone === 'bad') return theme.colors.bad;
  if (tone === 'warn') return theme.colors.warn;
  if (tone === 'brand') return theme.colors.brand;
  return theme.colors.line2;
}

const rowStyle = (theme: ReturnType<typeof useTheme>, last: boolean) =>
  ({
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 11,
    paddingHorizontal: 14,
    ...(last ? null : { borderBottomWidth: 1, borderBottomColor: theme.colors.line }),
  }) as const;

/** A rounded card of rows on `sf`, as the list's groups. */
function Card({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/** A section of plain lines (ASKS YOU FIRST, LIMITS): each line, its detail quieter under it. */
function Lines({ title, lines }: { title: string; lines: readonly AutomationPlanLine[] }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <SectionLabel>{title}</SectionLabel>
      <Card>
        {lines.map((l, i) => (
          <View
            key={l.text}
            accessible
            style={[
              rowStyle(theme, i === lines.length - 1),
              { flexDirection: 'column', alignItems: 'stretch', gap: 2 },
            ]}
          >
            <Text size={14} lh={1.35} color={theme.colors.ink2}>
              {l.text}
            </Text>
            {l.detail ? (
              <Text size={12.5} lh={1.4} color={theme.colors.mut}>
                {l.detail}
              </Text>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

/**
 * What happens, step by step (AP-6332): a rail of round marks joined by a line — what starts it filled, the agent's
 * steps its picture — each step's title, its details and its marks; a check between steps is a dashed stretch of the
 * rail with its question and what a no does, in italics.
 */
function Flow({ items, agentId }: { items: readonly AutomationFlowItem[]; agentId: string | null }) {
  const theme = useTheme();
  const { people } = useBurrowBase();
  return (
    <View style={{ paddingHorizontal: 2, paddingTop: 4 }}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        if (item.kind === 'gate')
          return (
            <View key={item.id} style={{ flexDirection: 'row', gap: 12 }} accessible>
              <View style={{ width: 28, alignItems: 'center' }}>
                <View
                  style={{
                    flex: 1,
                    width: 0,
                    borderLeftWidth: 2,
                    borderColor: theme.colors.line2,
                    borderStyle: 'dashed',
                  }}
                />
              </View>
              <Text
                size={12.5}
                lh={1.4}
                color={theme.colors.mut}
                style={{ flex: 1, fontStyle: 'italic', paddingBottom: 12 }}
              >
                {item.text}
              </Text>
            </View>
          );
        const when = item.kind === 'when';
        const Icon = when ? Zap : item.icon === 'agent' ? null : ICONS[item.icon];
        return (
          <View key={when ? 'when' : item.id} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ width: 28, alignItems: 'center' }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  borderWidth: 1,
                  borderColor: when ? theme.colors.btn : theme.colors.line2,
                  backgroundColor: when ? theme.colors.btn : theme.colors.sf2,
                }}
              >
                {Icon ? (
                  <Icon size={15} color={when ? theme.colors.btnfg : theme.colors.ink2} strokeWidth={1.9} />
                ) : (
                  <PrincipalAvatar principal={agentId ? people.get(agentId) : null} size={26} />
                )}
              </View>
              {last ? null : (
                <View
                  style={{
                    flex: 1,
                    width: 2,
                    minHeight: 10,
                    marginVertical: 3,
                    backgroundColor: theme.colors.line2,
                  }}
                />
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0, paddingTop: 3, paddingBottom: 16, gap: 3 }} accessible>
              <Text size={15} weight={600} lh={1.3}>
                {when ? item.text : item.title}
              </Text>
              {item.details.map((d) => (
                <Text key={d} size={13.5} lh={1.45} color={theme.colors.ink2}>
                  {d}
                </Text>
              ))}
              {!when && item.marks.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {item.marks.map((m) => {
                    const c = tagColors(theme.colors, MARK_TONES[m.tone]);
                    return (
                      <View
                        key={m.label}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                          paddingHorizontal: 8,
                          paddingVertical: 2,
                          borderRadius: 7,
                          borderWidth: 1,
                          borderColor: c.border,
                          backgroundColor: c.background,
                        }}
                      >
                        <ArrowUpRight size={12} color={c.text} strokeWidth={2} />
                        <Text size={12} weight={500} color={c.text}>
                          {m.label}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The lines under On, Off or Not on yet: its last run and its next while it is on, its last run (or that it doesn't run)
 * while off, and what waits shows on its own line with Open.
 */
function stateLines(state: AutomationState, waiting: boolean): string[] {
  if (state.runs === 'on') return [state.last, state.next].filter((l): l is string => !!l);
  if (state.runs === 'off') return [state.line === state.last ? state.last : state.line];
  return waiting ? [] : [state.line];
}
