/**
 * Chat pieces: messages as flat full-width rows under their author line, like the web (docs/decisions/android-chat.md
 * AP-706; the DM mock's bubbles are gone), the RECEIPTS card under agent answers, compact card summaries, the run line
 * and the run card's progress (AP-705), the pill composer (no `@` list or “To Banjo” chip since one agent, AP-4982)
 * and a "{name} is thinking" row.
 */

import { LIVE_BUST_MIN_SIZE } from '@whombat/avatars/motion';
import {
  agentFaceOf,
  agentNowFor,
  autocorrectComposerMention,
  cardFrameWords,
  clientTranslator,
  handoffWords,
  isAutomationPrincipal,
  movedCardWords,
  type ReportLine,
  type RunChips,
  type SettledLine,
  type ThreadStage,
  threadNewLabel,
  threadRowLabel,
  threadStageWord,
  threadStageWords,
  type UploadItem,
  type WorkLine,
  workingFaceState,
} from '@whombat/client';
import type { AgentNowEntry } from '@whombat/client/query';
import type { DigestCard, DigestItem, MentionTarget, Principal, Receipt } from '@whombat/core';
import { formatDigestLabel, formatDuration, turnStopLabel, typingLabel } from '@whombat/core';
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrincipalAvatar } from '../avatars/Avatars';
import { LiveFace } from '../avatars/LiveFace';
import { canSend } from '../data/attachments';
import { useBurrowBase, useNowLabel } from '../data/BurrowProvider';
import { composerMaxHeight, plusLabel } from '../data/chatInbox';
import {
  type CardSummary,
  lastReplyFollowsClock,
  lastReplyText,
  type RunCardModel,
  type RunLineModel,
  type RunSettledModel,
} from '../data/messages';
import { type ThreadWorkView, thinkingLabels } from '../data/working';
import { mobileTranslator, useI18n, useMobileT } from '../i18n';
import { nextElapsedTick, RUN_SECONDS_BELOW_MS } from '../lib/elapsed';
import { pulseRange } from '../lib/pulse';
import { useOpenUrl } from '../navigation/hooks';
import { ComposerLineContext, GlassBarRoomContext } from '../navigation/panes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { useComposerVoice, type VoiceSource } from '../voice/useComposerVoice';
import { MicButton, VoiceBar } from '../voice/VoiceBar';
import { type AddChoice, AddSheet, UploadChips } from './attachments';
import { CardMarkGlyph, SummaryFrame } from './cardFrame';
import { HandoffMinutesText, T3Tile } from './handoff';
import { haptic } from './haptics';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, GitBranch, Plus } from './icons';
import { ABOVE_KEYBOARD, type BelowComposer, composerBottomPadding } from './insets';
import { useKeyboardPadding } from './keyboard';
import { hasNativeMenu, NativeMenu } from './nativeMenu';
import { Button, toneColor } from './primitives';
import { RichText } from './rich';
import { useBelowScreen } from './screenBottom';
import { useAfterSheet } from './sheet';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';
import { useWorkLineSpoken, WorkLineRow } from './workLine';

/**
 * A message's text and what hangs under it (receipts, cards, quick replies): a flat row the width of the list, no
 * bubble, everyone's alike — the web's message row (AP-706). Not sent yet: in `mut`, still readable (never faded, so it
 * keeps 4.5:1; docs/decisions/chat-threads-cards.md). `selectable`: on iPhone its words are selected with a hold, as in
 * iOS's own apps (ios-native.md).
 */
export function MessageBody({
  text,
  sending,
  selectable = false,
  children,
}: {
  text: string;
  sending?: boolean;
  selectable?: boolean;
  /** Under the text (receipts, card). */
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ alignSelf: 'stretch', gap: 8 }}>
      {text ? (
        <View>
          <RichText
            text={text}
            color={sending ? theme.colors.mut : theme.colors.ink}
            accentColor={theme.colors.brand}
            codeBackground={theme.colors.sf2}
            selectable={selectable && !sending}
          />
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** RECEIPTS card: numbered rows (20dp sf2 square · source · where), full width. */
export function ReceiptsCard({
  receipts,
  onOpen,
}: {
  receipts: readonly Receipt[];
  onOpen?: (receipt: Receipt) => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={tMobile('ui.receipts')}
      style={{
        alignSelf: 'stretch',
        flexDirection: 'column',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingVertical: 2,
        paddingHorizontal: 14,
      }}
    >
      {receipts.map((r) => (
        <Touchable
          key={r.n}
          onPress={onOpen ? () => onOpen(r) : undefined}
          disabled={!onOpen || !r.link}
          feedback="fade"
          accessibilityRole="link"
          accessibilityLabel={tMobile('screens2.chat.receipt', {
            n: r.n,
            source: r.source,
            detail: r.detail,
          })}
          hitSlop={hitSlopFor(40)}
          style={{
            flexDirection: 'row',
            gap: 10,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
            opacity: 1,
          }}
        >
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              backgroundColor: theme.colors.sf2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text size={10.5} weight={500} mono>
              {String(r.n)}
            </Text>
          </View>
          <View style={{ flex: 1, flexDirection: 'column', gap: 1 }}>
            <Text size={14}>{r.source}</Text>
            <Text size={11} mono color={theme.colors.mut}>
              {r.detail}
            </Text>
          </View>
        </Touchable>
      ))}
    </View>
  );
}

/**
 * Quick replies under an agent's newest bubble (docs/decisions/rich-messages.md RM-05): pill chips, a tap
 * sends at once. 36dp tall with a hit area grown to 44.
 */
export function QuickReplies({
  suggestions,
  onPick,
  disabled,
  label: givenLabel,
}: {
  suggestions: readonly string[];
  onPick: (text: string) => void;
  disabled?: boolean;
  /** The group's name for TalkBack. */
  label?: string;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const label = givenLabel ?? tMobile('screens2.chat.quickReplies');
  return (
    <View accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {suggestions.map((text) => (
        <Touchable
          key={text}
          onPress={() => onPick(text)}
          disabled={disabled}
          feedback="wash"
          ringRadius={18}
          accessibilityLabel={text}
          hitSlop={hitSlopFor(36)}
          style={{
            minHeight: 36,
            justifyContent: 'center',
            paddingHorizontal: 14,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
            opacity: disabled ? 0.6 : 1,
          }}
        >
          <Text size={14}>{text}</Text>
        </Touchable>
      ))}
    </View>
  );
}

function DigestRow({ item }: { item: DigestItem }) {
  const openUrl = useOpenUrl();
  const theme = useTheme();
  const body = (
    <>
      <Text size={11.5} mono color={theme.colors.mut} style={{ width: 42 }}>
        {item.time ?? ''}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={14.5} weight={600} lh={1.35}>
          {item.title}
          {item.source ? (
            <Text size={13} color={theme.colors.mut}>
              {`  ${item.source}`}
            </Text>
          ) : null}
        </Text>
        {item.note ? (
          <Text size={13.5} lh={1.42} color={theme.colors.ink2}>
            {item.note}
          </Text>
        ) : null}
      </View>
    </>
  );
  const row = {
    flexDirection: 'row' as const,
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.line,
  };
  const url = item.url;
  return url ? (
    <Touchable
      onPress={() => openUrl(url)}
      feedback="wash"
      accessibilityRole="link"
      accessibilityLabel={[item.time, item.title, item.source, item.note].filter(Boolean).join(', ')}
      style={{ ...row, minHeight: 44 }}
    >
      {body}
    </Touchable>
  ) : (
    <View style={row}>{body}</View>
  );
}

/** A digest card (RM-08), whole: `INBOX · 7 UNREAD`, sections of items; collapsed ones fold to a line. */
export function DigestCardView({ card }: { card: DigestCard }) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <View
      accessibilityLabel={[card.title, card.summary].filter(Boolean).join(', ')}
      style={{
        alignSelf: 'stretch',
        gap: 12,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingTop: 12,
        paddingBottom: 4,
        paddingHorizontal: 14,
      }}
    >
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
        {formatDigestLabel(card.title, card.summary, rawLocale)}
      </Text>
      {card.sections.map((section, i) => {
        const open = !section.collapsed || opened.has(i);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: sections are positional and never reorder
          <View key={i}>
            <Text
              size={10.5}
              weight={500}
              mono
              tracking={0.05}
              uppercase
              color={theme.colors.ink2}
              style={{ paddingBottom: 6 }}
            >
              {`${section.label} · ${section.items.length}`}
            </Text>
            {open ? (
              section.items.map((item, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
                <DigestRow key={n} item={item} />
              ))
            ) : (
              <Touchable
                onPress={() => setOpened((s) => new Set(s).add(i))}
                feedback="wash"
                accessibilityLabel={tMobile('screens2.chat.showItems', {
                  count: section.items.length,
                  items: section.items.map((it) => it.title).join(', '),
                })}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text size={13.5} color={theme.colors.mut} numberOfLines={1} style={{ flex: 1 }}>
                  {section.items.map((it) => it.title).join(' · ')}
                </Text>
                <Text size={11} weight={500} mono color={theme.colors.brand}>
                  {tMobile('screens2.chat.show', { count: section.items.length })}
                </Text>
              </Touchable>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Three pulsing dots, flat like the messages (AP-706): "Dusty is thinking". `label` says what the agent does instead (`Banjo · Editing Layout.astro · 1m 12s`, AP-734); `spoken` is what TalkBack reads,
 * without the ticking clock so it isn't announced every second.
 */
export function ThinkingBubble({
  name,
  label: shown,
  spoken,
  face,
  onStop,
  stopping = false,
}: {
  name: string;
  label?: string;
  spoken?: string;
  /** Before the dots: the agent's live face, where its next message will start (docs/decisions/face-motion.md). */
  face?: ReactNode;
  /** Stop the agent's turn (contracts 0.55, MX-09); no Stop without it. */
  onStop?: () => void;
  /** The stop is on its way: the button waits. */
  stopping?: boolean;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const label = shown ?? typingLabel(name, rawLocale);
  const words = (
    <View
      accessible
      accessibilityLabel={spoken ?? label}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6, flexShrink: 1 }}
    >
      <View style={{ paddingVertical: 6 }}>
        <PulseDots />
      </View>
      {/* One line, shortened in the middle: the agent's name and its clock stay, and the row keeps its height as what it
          does changes (two lines and back moved the list held at its end). */}
      <Text size={11} weight={500} mono color={theme.colors.mut} numberOfLines={1} ellipsizeMode="middle">
        {label}
      </Text>
    </View>
  );
  const line = face ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 }}>
      {face}
      {words}
    </View>
  ) : (
    words
  );
  if (!onStop) return line;
  // Stop sits at the line's end (MX-09): a 44dp text button, after the words in the reading order.
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      {line}
      <Touchable
        onPress={onStop}
        disabled={stopping}
        accessibilityLabel={`${turnStopLabel(rawLocale)} ${name}`}
        accessibilityHint={tMobile('screens2.chat.stopsWorking', { name })}
        feedback="wash"
        ringRadius={10}
        style={{
          minHeight: 44,
          minWidth: 44,
          paddingHorizontal: 12,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: theme.colors.line2,
          opacity: stopping ? 0.5 : 1,
        }}
      >
        <Text size={13.5} weight={600} color={theme.colors.ink}>
          {turnStopLabel(rawLocale)}
        </Text>
      </Touchable>
    </View>
  );
}

/**
 * The thinking row with what the agent does (docs/decisions/card-settle.md AP-734): `Banjo · Editing Layout.astro ·
 * 1m 12s` from its latest action in this conversation and thread (`useAgentNow`), ticking each second while shown;
 * `Banjo is thinking` without a recent action. An agent's row starts with its live face, 40 dp, the smallest that blinks
 * and eases between looks: thinking, then at work once its turn acts, looking at the person while an action waits.
 */
export function WorkingBubble({
  principalId,
  agent,
  name,
  threadRootId,
  agentNow,
  clock,
  onStop,
  stopping,
}: {
  principalId: string;
  /** Who is thinking: an agent shows its face. */
  agent?: Principal | undefined;
  name: string;
  threadRootId: string | null;
  agentNow: readonly AgentNowEntry[];
  /** The app clock (ms), the server's time. */
  clock: () => number;
  /** Stop the turn (MX-09), where the viewer may. */
  onStop?: () => void;
  stopping?: boolean;
}) {
  const { rawLocale } = useI18n();
  // Ticks each second only while the agent reports actions here.
  const nowMs = useTicker(
    clock,
    thinkingLabels(name, agentNow, principalId, threadRootId, 0, rawLocale).ticks,
  );
  const words = thinkingLabels(name, agentNow, principalId, threadRootId, nowMs, rawLocale);
  const state = workingFaceState(agentNowFor(agentNow, principalId, threadRootId, nowMs));
  const face =
    agent?.kind === 'agent' && !isAutomationPrincipal(agent) ? (
      <LiveFace face={agentFaceOf(agent)} size={LIVE_BUST_MIN_SIZE} state={state} />
    ) : undefined;
  return (
    <ThinkingBubble
      name={name}
      label={words.label}
      spoken={words.spoken}
      face={face}
      {...(onStop ? { onStop, stopping: stopping === true } : {})}
    />
  );
}

/**
 * A day divider between two hairlines (MX-05, the web's `DayDivider`): `Today · Wednesday 7 October` in mono 500 11.5
 * `mut`. TalkBack reads it as a heading, so a long conversation can be walked day by day.
 */
export function DayDivider({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 2 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
      <Text size={11.5} weight={500} mono color={theme.colors.mut}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.line }} />
    </View>
  );
}

/** The “New” line above the first message the reader hadn't read when they opened the conversation (MX-05). */
export function UnreadLine({ label, tone = 'brand' }: { label: string; tone?: 'brand' | 'new' }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  // In Chat and Feedback blue means “new” everywhere: the inbox's dot and count, and this line in a thread.
  const color = tone === 'new' ? theme.chart.chart1 : theme.colors.brand;
  return (
    <View
      accessible
      accessibilityLabel={tMobile('ui.new-messages-from-here')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: color }} />
      <Text size={11.5} weight={600} mono uppercase tracking={0.05} color={color}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Name (+ avatar) and time above the agent's (or an automation's) first message in a run; `status` after the name:
 * “Automation” for an automation's own messages (AP-1000). The person's own message in Chat and its threads has their
 * face without their name (`name` null; docs/decisions/chat-threads-cards.md).
 */
export function AuthorLine({
  avatar,
  name,
  time,
  status,
  after,
}: {
  avatar: ReactNode;
  name: string | null;
  time: string;
  status?: string | null;
  /** After the time: what answered an assistant's reply in Chat (chat-runtime-android.md AP-2726). */
  after?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: -6 }}>
      {avatar}
      {/* A long name (an automation's, AP-1000) gives way first: its tag and the time stay on the line. */}
      {name !== null ? (
        <Text size={13.5} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
          {name}
        </Text>
      ) : null}
      {status ? (
        <Text size={11.5} mono color={theme.colors.mut}>
          {status}
        </Text>
      ) : null}
      <Text size={11.5} mono color={theme.colors.mut}>
        {time}
      </Text>
      {after}
    </View>
  );
}

export interface CardButton {
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary';
  accessibilityHint?: string;
  /** Its request is in flight: the button waits, the others stay. */
  busy?: boolean;
}

/** A link under a card (“Open plan ›”, “Watch run ›”): 44dp, brand, the card itself then isn't a button. */
export interface CardLink {
  label: string;
  onPress: () => void;
}

/** The system's “Remove animations” setting, kept current. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReduced(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/**
 * A live run's progress (AP-668, AP-705): a track in `sf2` whose `progress` fill (at least 8%) carries a sheen sweeping
 * every 1.4s; nothing moves when `still` (the run needs a person) or with “Remove animations”. The run line's is 3dp
 * under its text, the run card's 6dp as on the web.
 */
export function RunProgressBar({
  progress,
  still = false,
  height = 3,
  style,
}: {
  /** 0–100. */
  progress: number;
  still?: boolean;
  height?: number;
  style?: ViewStyle;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const [barWidth, setBarWidth] = useState(0);
  const animate = !still && !reduced;
  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      sweep.setValue(0);
    };
  }, [animate, sweep]);
  const filled = (barWidth * Math.max(progress, 8)) / 100;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={tMobile('ui.run-progress')}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress) }}
      onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
      style={[
        { height, borderRadius: height / 2, backgroundColor: theme.colors.sf2, overflow: 'hidden' },
        style,
      ]}
    >
      <View
        style={{
          width: filled,
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: theme.colors.progress,
          overflow: 'hidden',
        }}
      >
        {animate && filled > 0 ? (
          <Animated.View
            style={{
              width: filled * 0.4,
              height: '100%',
              backgroundColor: theme.colors.presence,
              opacity: 0.8,
              transform: [
                {
                  translateX: sweep.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-filled * 0.4, filled],
                  }),
                },
              ],
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

/** A run card's `+42 −7 · 3 files · PR #482` (AP-705), the diff in the run screen's colours. */
function RunCardMeta({ run }: { run: RunCardModel }) {
  const theme = useTheme();
  if (!run.diff && !run.pr) return null;
  return (
    <Text size={12} weight={500} mono color={theme.colors.mut} numberOfLines={1}>
      {run.diff ? (
        <>
          <Text size={12} weight={500} mono color={theme.colors.ok}>
            {run.diff.add}
          </Text>{' '}
          <Text size={12} weight={500} mono color={theme.colors.bad}>
            {run.diff.del}
          </Text>
          {` · ${run.diff.files}`}
        </>
      ) : null}
      {run.pr ? `${run.diff ? ' · ' : ''}${run.pr}` : null}
    </Text>
  );
}

/** The run card's words for TalkBack: `+42 −7 · 3 files · PR #482` as “42 added, 7 removed, 3 files, PR #482”. */
function runCardMetaLabel(run: RunCardModel | null | undefined): string | null {
  if (!run || (!run.diff && !run.pr)) return null;
  return [run.diff ? `${run.diff.add} ${run.diff.del} ${run.diff.files}` : null, run.pr]
    .filter(Boolean)
    .join(', ');
}

/**
 * The send button's look, the same in Chat, threads and Automations: with nothing to send an outline in `line2` with a
 * `mut` arrow; with something, filled `btn` with a `btnfg` arrow.
 */
export function sendLook(
  theme: ReturnType<typeof useTheme>,
  ready: boolean,
): { box: ViewStyle; arrow: string } {
  return {
    box: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: ready ? theme.colors.btn : 'transparent',
      borderWidth: ready ? 0 : 1,
      borderColor: theme.colors.line2,
    },
    arrow: ready ? theme.colors.btnfg : theme.colors.mut,
  };
}

/** A chat card (plan, run, review, approval…) as a compact card under the message, the message's full width. */
export function CardSummaryView({
  card,
  onPress,
  action,
  actions,
  buttons,
  note,
  busy = false,
  details = null,
  collapse,
  door = null,
}: {
  card: CardSummary;
  onPress?: () => void;
  /** A link under the card (the plan card's “Open plan”); the card itself then isn't a button. */
  action?: CardLink;
  /** Links side by side under the card (the run card's “Watch run” and “Branch room”, AP-705). */
  actions?: readonly CardLink[];
  /** 44dp buttons side by side under the card (an assessment's options; a run's Try again). */
  buttons?: readonly CardButton[];
  /** A quiet line under the card (“Decide on the web.”). */
  note?: string | null;
  busy?: boolean;
  /** Folded rows under the buttons (the assessor's full assessment, Whombat FB-32), opened by a 44dp row. */
  details?: {
    title: string;
    rows: readonly { label: string; text: string }[];
    items?: readonly string[];
  } | null;
  /**
   * The card was opened from its line (docs/decisions/card-settle.md AP-730): a 44dp “Hide card” in its top right
   * corner returns the line.
   */
  collapse?: () => void;
  /** An approval waiting on the viewer: one full-width button that opens where it is answered. */
  door?: { label: string; onPress: () => void } | null;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const run = card.run ?? null;
  const approval = card.approvalDoor ?? null;
  const answered = approval?.state ?? null;
  const label = [card.label, card.title, card.detail, answered?.text, card.meta, runCardMetaLabel(run)]
    .filter(Boolean)
    .join(', ');
  const body = (
    <>
      {card.label ? (
        <Text
          size={approval ? 12 : 11}
          weight={500}
          mono
          tracking={0.05}
          color={
            // The waiting eyebrow in the readable warn of status words (ui-refresh-status.md).
            approval?.waiting ? theme.colors.warnText : toneColor(theme, card.tone)
          }
        >
          {card.label}
        </Text>
      ) : null}
      {card.title ? (
        <Text
          size={approval ? 17 : 15.5}
          weight={card.quiet ? 500 : 600}
          color={card.quiet ? theme.colors.mut : undefined}
          numberOfLines={card.kind === 'report' ? 4 : 2}
        >
          {card.title}
        </Text>
      ) : null}
      {run?.live ? (
        <RunProgressBar
          progress={run.progress}
          still={run.attention}
          height={6}
          style={{ marginVertical: 4 }}
        />
      ) : null}
      {card.detail ? (
        // A task's full words (at most 600 characters) are what its line opens to (AP-4305).
        <Text size={14} lh={1.42} color={theme.colors.ink2} numberOfLines={card.task ? undefined : 3}>
          {card.detail}
        </Text>
      ) : null}
      {answered ? (
        <Text size={14} weight={500} color={toneColor(theme, answered.tone === 'mut' ? null : answered.tone)}>
          {answered.text}
        </Text>
      ) : null}
      {card.meta ? (
        <Text size={12} mono color={toneColor(theme, card.tone)}>
          {card.meta}
        </Text>
      ) : null}
      {run ? <RunCardMeta run={run} /> : null}
    </>
  );
  // Waiting is the only state that asks for attention: an answered approval gets the calm frame.
  const loud = approval ? approval.waiting : card.kind === 'approval' && card.tone === 'warn';
  const style = {
    alignSelf: 'stretch' as const,
    gap: 6,
    borderRadius: 16,
    borderWidth: loud ? 1.5 : 1,
    borderColor: loud ? theme.colors.warn : theme.colors.line,
    backgroundColor: theme.colors.sf,
    paddingVertical: 12,
    paddingHorizontal: 14,
  };
  const links = actions ?? (action ? [action] : []);
  // A plan or a run card in the cards' one layout (docs/decisions/chat-threads-cards.md).
  if (card.head)
    return (
      <SummaryFrame
        head={card.head}
        links={links}
        buttons={buttons ?? []}
        busy={busy}
        bar={run?.live ? <RunProgressBar progress={run.progress} still={run.attention} height={6} /> : null}
        meta={run ? <RunCardMeta run={run} /> : null}
        corner={collapse ? <HideCardButton onPress={collapse} /> : null}
      />
    );
  const folded = details ? (
    <View style={{ gap: 8 }}>
      <Touchable
        onPress={() => setOpen((v) => !v)}
        feedback="wash"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={details.title}
        style={{
          minHeight: 44,
          justifyContent: 'center',
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
        }}
      >
        <Text size={14} weight={600}>
          {`${open ? '▾' : '▸'} ${details.title}`}
        </Text>
      </Touchable>
      {open
        ? details.rows.map((row) => (
            <Text key={row.label} size={14} lh={1.45} color={theme.colors.ink2}>
              <Text size={14} weight={600}>{`${row.label}: `}</Text>
              {row.text}
            </Text>
          ))
        : null}
      {open && details.items?.length
        ? details.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
            <Text key={i} size={13.5} lh={1.45} color={theme.colors.ink2}>
              {`• ${item}`}
            </Text>
          ))
        : null}
    </View>
  ) : null;
  // More than two options stack, each full width (44dp targets with room for the assessor's labels).
  const stacked = (buttons?.length ?? 0) > 2;
  // A card opened from its line has “Hide card” beside its words, in the top right corner (AP-730).
  const hide = collapse ? <HideCardButton onPress={collapse} /> : null;
  const words = (
    <View accessible accessibilityLabel={label} style={{ flex: hide ? 1 : undefined, gap: 6 }}>
      {body}
    </View>
  );
  if (door)
    return (
      <View style={style}>
        {words}
        <Button
          label={door.label}
          variant="secondary"
          onPress={door.onPress}
          accessibilityLabel={`${door.label.replace(/ ›$/, '')}: ${card.title}`}
          // Android's 48dp target, iOS's 44pt.
          style={{ marginTop: 6, minHeight: Platform.OS === 'android' ? 48 : 44 }}
        />
      </View>
    );
  if (buttons?.length || note || details || links.length || (hide && !onPress))
    return (
      <View style={style}>
        {hide ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            {words}
            {hide}
          </View>
        ) : (
          words
        )}
        {note ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {note}
          </Text>
        ) : null}
        {links.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
            {links.map((l) => (
              <Touchable
                key={l.label}
                onPress={l.onPress}
                feedback="wash"
                accessibilityRole="link"
                accessibilityLabel={card.title ? `${l.label}: ${card.title}` : l.label}
                ringRadius={10}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  // The 44dp target reaches into the card's padding rather than spacing the card out.
                  marginTop: -8,
                  marginBottom: buttons?.length || details ? -4 : -10,
                  marginLeft: -8,
                  paddingHorizontal: 8,
                  borderRadius: 10,
                }}
              >
                <Text size={14} weight={500} color={theme.colors.brand}>
                  {`${l.label} ›`}
                </Text>
              </Touchable>
            ))}
          </View>
        ) : null}
        {buttons?.length ? (
          <View style={{ flexDirection: stacked ? 'column' : 'row', gap: 8, paddingTop: 4 }}>
            {buttons.map((b) => (
              <Button
                key={b.label}
                label={b.label}
                variant={b.variant}
                disabled={busy}
                busy={b.busy}
                onPress={b.onPress}
                accessibilityHint={b.accessibilityHint}
                style={stacked ? undefined : { flex: 1 }}
              />
            ))}
          </View>
        ) : null}
        {folded}
      </View>
    );
  if (onPress && hide)
    return (
      <View style={[style, { flexDirection: 'row', alignItems: 'flex-start' }]}>
        <Touchable
          onPress={onPress}
          feedback="wash"
          accessibilityLabel={label}
          style={{ flex: 1, gap: 6, borderRadius: 10 }}
        >
          {body}
        </Touchable>
        {hide}
      </View>
    );
  return onPress ? (
    <Touchable onPress={onPress} feedback="wash" accessibilityLabel={label} style={style}>
      {body}
    </Touchable>
  ) : (
    <View style={style} accessible accessibilityLabel={label}>
      {body}
    </View>
  );
}

/** “Hide card” in the top right corner of a card opened from its line (AP-730): returns the line. 44dp. */
export function HideCardButton({ onPress }: { onPress: () => void }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={tMobile('ui.hide-card')}
      accessibilityState={{ expanded: true }}
      ringRadius={12}
      style={{
        width: 44,
        height: 44,
        // The 44dp target reaches into the card's padding.
        marginTop: -12,
        marginRight: -12,
        marginBottom: -12,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ChevronUp size={18} color={theme.colors.mut} strokeWidth={2} />
    </Touchable>
  );
}

/**
 * The run line (docs/decisions/run-line.md AP-668): a run that hasn't changed anything, as one 44dp row under its
 * message instead of a card, the message's full width (AP-706). While live the dot breathes and a thin bar's sheen
 * sweeps (not with “Remove animations”); once it ends, `Run #6 · Done in 1m 12s · {summary}`. Tapping it opens the run:
 * “Watch ›” while live, “Open ›” after (AP-699). A failed run offers Try again beside it where the Whombat can (AP-705).
 */
export function RunLineView({
  line,
  onPress,
  onRetry,
  retrying = false,
}: {
  line: RunLineModel;
  onPress: () => void;
  /** Try again (`runs.retry`); shown only when the line offers it. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  // Nothing moves while the run needs a person (tone `warn`).
  const animate = line.tone === 'live' && !reduced;
  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [animate, pulse]);
  const dot =
    line.tone === 'live'
      ? theme.colors.progress
      : line.tone === 'mut'
        ? theme.colors.mut
        : toneColor(theme, line.tone);
  const retry = line.retry && onRetry;
  return (
    <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Touchable
        onPress={onPress}
        feedback="wash"
        accessibilityRole="link"
        accessibilityLabel={[line.lead, line.detail].filter(Boolean).join(', ')}
        accessibilityHint={tMobile('ui.opens-the-run')}
        ringRadius={10}
        style={{ flex: 1, minHeight: 44, justifyContent: 'center', gap: 6, paddingVertical: 6 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Animated.View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: dot,
              opacity: animate
                ? pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.35, 1] })
                : 1,
            }}
          />
          <Text size={14} lh={1.4} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
            <Text size={14} weight={600} color={line.tone === 'warn' ? theme.colors.warn : undefined}>
              {line.lead}
            </Text>
            {line.detail ? ` · ${line.detail}` : ''}
          </Text>
          <Text size={13.5} weight={500} color={theme.colors.mut} style={{ marginLeft: 'auto' }}>
            {line.link}
          </Text>
        </View>
        {line.live ? (
          <RunProgressBar progress={line.progress} still={line.tone !== 'live'} style={{ marginLeft: 18 }} />
        ) : null}
      </Touchable>
      {retry ? (
        <Touchable
          onPress={onRetry}
          disabled={retrying}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={tClient('settings.retry')}
          accessibilityHint={tMobile('screens2.chat.retryRunHint', { name: line.agentName })}
          accessibilityState={{ disabled: retrying, busy: retrying }}
          ringRadius={10}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, marginRight: -8 }}
        >
          <Text size={13.5} weight={600} color={retrying ? theme.colors.mut : theme.colors.brand}>
            {tClient('settings.retry')}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** A line's dot colour (the run line's): live in the progress colour, muted in `mut`, else its tone. */
function lineDotColor(theme: ReturnType<typeof useTheme>, tone: SettledLine['tone']): string {
  if (tone === 'live') return theme.colors.progress;
  if (tone === 'mut') return theme.colors.mut;
  return toneColor(theme, tone);
}

/** A run's `PR #3` and `+12 −8` (docs/decisions/card-settle.md AP-731), small mono chips in `sf2`. */
export function RunChipsView({ chips }: { chips: RunChips }) {
  const theme = useTheme();
  if (!chips.prNumber && !chips.diff) return null;
  const chip = {
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 999,
    backgroundColor: theme.colors.sf2,
  } as const;
  const [add, del] = chips.diff?.split(' ') ?? [];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {chips.prNumber ? (
        <View style={chip}>
          <Text size={11.5} weight={500} mono color={theme.colors.ink2}>
            {`PR #${chips.prNumber}`}
          </Text>
        </View>
      ) : null}
      {chips.diff ? (
        <View style={chip}>
          <Text size={11.5} weight={500} mono color={theme.colors.ok}>
            {add}{' '}
            <Text size={11.5} weight={500} mono color={theme.colors.bad}>
              {del}
            </Text>
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** What TalkBack reads for the chips: “PR #3, 12 added, 8 removed”. */
function chipsLabel(chips: RunChips | null | undefined, locale?: string | null): string | null {
  const tr = mobileTranslator(locale);
  if (!chips) return null;
  const [add, del] = chips.diff?.split(' ') ?? [];
  return (
    [
      chips.prNumber ? `PR #${chips.prNumber}` : null,
      add ? tr.t('screens2.chat.added', { count: add.slice(1) }) : null,
      del ? tr.t('screens2.chat.removed', { count: del.slice(1) }) : null,
    ]
      .filter(Boolean)
      .join(', ') || null
  );
}

/**
 * A settled card as one line (docs/decisions/card-settle.md AP-730, AP-731), in the run line's anatomy: a status dot
 * in the tone, the bold lead, the muted detail; tapping it opens the card in place (the card's “Hide card” returns the
 * line). A run's line adds its `PR #3` and `+12 −8` under the text and “Open ›” to the run beside it. Inside a run
 * (AP-732) it is indented under the run's dot. Without `onOpen` it is only the line, with nothing to open (an ended Find
 * My watch, whose card said no more).
 */
export function SettledLineView({
  line,
  onOpen,
  chips = null,
  link = null,
  indent = false,
  lines = 1,
}: {
  line: SettledLine;
  /** Opens the card in place; without it the line opens nothing. */
  onOpen?: () => void;
  chips?: RunChips | null;
  /** “Open ›” beside a run's line: the run screen. */
  link?: { label: string; onPress: () => void } | null;
  indent?: boolean;
  /** How many lines its words may take: a server task's outcome takes two on the phone (AP-4305). */
  lines?: number;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const words = [line.lead, line.detail].filter(Boolean).join(', ');
  const chipWords = chipsLabel(chips, rawLocale);
  const hasChips = !!chips && (!!chips.prNumber || !!chips.diff);
  const dotAndWords = (
    <>
      <View
        style={{
          width: 8,
          height: 8,
          // On the first line's middle when the words wrap.
          marginTop: lines > 1 ? 6 : 0,
          borderRadius: 4,
          backgroundColor: lineDotColor(theme, line.tone),
        }}
      />
      <Text size={14} lh={1.4} color={theme.colors.ink2} numberOfLines={lines} style={{ flexShrink: 1 }}>
        <Text size={14} weight={600} color={line.tone === 'warn' ? theme.colors.warn : undefined}>
          {line.lead}
        </Text>
        {line.detail ? ` · ${line.detail}` : ''}
      </Text>
    </>
  );
  if (!onOpen)
    return (
      <View
        accessible
        accessibilityLabel={words}
        style={{
          alignSelf: 'stretch',
          marginLeft: indent ? 18 : 0,
          minHeight: 44,
          justifyContent: 'center',
          paddingVertical: 6,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: lines > 1 ? 'flex-start' : 'center', gap: 10 }}>
          {dotAndWords}
        </View>
      </View>
    );
  const toggle = (
    <Touchable
      onPress={onOpen}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={tMobile('screens2.chat.showCard', {
        what: [words, chipWords].filter(Boolean).join(', '),
      })}
      accessibilityState={{ expanded: false }}
      ringRadius={10}
      style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 6 }}
    >
      <View style={{ flexDirection: 'row', alignItems: lines > 1 ? 'flex-start' : 'center', gap: 10 }}>
        {dotAndWords}
        <ChevronDown
          size={16}
          color={theme.colors.mut}
          strokeWidth={2}
          style={{ marginLeft: 'auto', marginTop: lines > 1 ? 2 : 0 }}
        />
      </View>
    </Touchable>
  );
  if (!hasChips && !link)
    return <View style={{ alignSelf: 'stretch', marginLeft: indent ? 18 : 0 }}>{toggle}</View>;
  // A run's line: its chips under the text, “Open ›” to the run at their right.
  return (
    <View style={{ alignSelf: 'stretch', marginLeft: indent ? 18 : 0 }}>
      {toggle}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: -16, marginBottom: -8 }}>
        <Touchable
          onPress={onOpen}
          feedback="none"
          accessible={false}
          importantForAccessibility="no"
          style={{ flex: 1, minHeight: 44, justifyContent: 'center', paddingLeft: 18 }}
        >
          {hasChips && chips ? <RunChipsView chips={chips} /> : null}
        </Touchable>
        {link ? (
          <Touchable
            onPress={link.onPress}
            feedback="wash"
            accessibilityRole="link"
            accessibilityLabel={tMobile('screens2.chat.openRun', { lead: line.lead })}
            ringRadius={10}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, marginRight: -8 }}
          >
            <Text size={13.5} weight={500} color={theme.colors.mut}>
              {link.label}
            </Text>
          </Touchable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A Whombat Feedback report in its conversation, as one row (docs/decisions/report-rows.md RR-01, RR-02; John: the
 * report cards took too much room): the dot in the assessment's tone, the outcome in 600 and one sentence (the
 * assessment's summary, else the visitor's words) at most two lines, over the reference and the facts in mono; a 44dp
 * Details on the right opens the whole report under the row (`children`), and Hide details folds it back. Plain text
 * only: the visitor's words never become Markdown, links or mentions.
 */
export function ReportLineView({
  line,
  expanded,
  onToggle,
  children,
}: {
  line: ReportLine;
  expanded: boolean;
  onToggle: () => void;
  /** The whole report, under the row while `expanded`. */
  children?: ReactNode;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const facts = [line.reference, ...line.meta].join(' · ');
  return (
    <View style={{ alignSelf: 'stretch', gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View
          accessible
          accessibilityLabel={[line.label, [line.lead, line.detail].filter(Boolean).join(': ')].join('. ')}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              marginTop: 6,
              borderRadius: 4,
              backgroundColor: lineDotColor(theme, line.tone),
            }}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={14} lh={1.4} color={theme.colors.ink2} numberOfLines={2}>
              <Text size={14} weight={600}>
                {line.lead}
              </Text>
              {line.detail ? ' · ' : ''}
              {line.detail ? (
                <Text
                  size={14}
                  color={line.quiet ? theme.colors.mut : theme.colors.ink2}
                  style={line.quiet ? { fontStyle: 'italic' } : undefined}
                >
                  {line.detail}
                </Text>
              ) : null}
            </Text>
            <Text size={11.5} mono color={theme.colors.mut}>
              {facts}
            </Text>
          </View>
        </View>
        <Touchable
          onPress={onToggle}
          feedback="fade"
          accessibilityRole="button"
          accessibilityLabel={tMobile(expanded ? 'screens2.chat.hideDetailsOf' : 'screens2.chat.detailsOf', {
            what: line.reference,
          })}
          accessibilityState={{ expanded }}
          ringRadius={10}
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}
        >
          {/* The card's small secondary button, inside the 44dp target. */}
          <View
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: theme.colors.line2,
            }}
          >
            <Text size={13.5} weight={500} numberOfLines={1}>
              {expanded ? tMobile('ui.hide-details') : tMobile('ui.details')}
            </Text>
          </View>
        </Touchable>
      </View>
      {expanded ? children : null}
    </View>
  );
}

/** A clock that re-renders every `ms` while `active`: the live card's elapsed time, the thinking line's. */
export function useTicker(clock: () => number, active: boolean, ms = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return clock();
}

/**
 * The app clock for a ticking “so far” time from `startedAt`: re-renders when the words can change — each second while
 * they show seconds (under `secondsBelowMs`), then once a minute — not every second for hours.
 */
export function useElapsedClock(clock: () => number, startedAt: string, secondsBelowMs: number): number {
  const [, setTick] = useState(0);
  const nowMs = clock();
  const wait = nextElapsedTick(nowMs - Date.parse(startedAt), secondsBelowMs);
  useEffect(() => {
    const timer = setTimeout(() => setTick((t) => t + 1), wait);
    return () => clearTimeout(timer);
  });
  return nowMs;
}

/**
 * A live run that changed something (docs/decisions/card-settle.md AP-733): the compact live card — its title, the 6dp
 * bar, `Now: …` and how long it has run (ticking), its PR and diff chips, “Watch ›” to the run, and a control that opens
 * the full card in place.
 */
export function LiveRunCardView({
  run,
  clock,
  onWatch,
  onOpen,
}: {
  run: RunSettledModel;
  /** The app clock (ms). */
  clock: () => number;
  onWatch: () => void;
  onOpen: () => void;
}) {
  const { rawLocale } = useI18n();
  const cardFrameWordsHere = cardFrameWords(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const nowMs = useElapsedClock(clock, run.startedAt, RUN_SECONDS_BELOW_MS);
  const elapsed = formatDuration(Math.max(0, nowMs - new Date(run.startedAt).getTime()), rawLocale);
  return (
    <View
      style={{
        alignSelf: 'stretch',
        gap: 6,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingTop: 12,
        paddingBottom: 2,
        paddingHorizontal: 14,
      }}
    >
      <View
        accessible
        accessibilityLabel={[
          run.title,
          run.now,
          tMobile('screens2.chat.soFar', { elapsed }),
          chipsLabel(run.chips, rawLocale),
        ]
          .filter(Boolean)
          .join(', ')}
        style={{ gap: 6 }}
      >
        {/* The cards' status line (docs/decisions/chat-threads-cards.md), how long it has run at its end. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <CardMarkGlyph mark="working" />
          <Text size={12.5} weight={500} color={theme.colors.ink2} style={{ flex: 1 }}>
            {cardFrameWordsHere.marks.working}
            <Text size={12.5} color={theme.colors.mut}>{` · ${cardFrameWordsHere.kinds.run}`}</Text>
          </Text>
          <Text size={12} weight={500} mono color={theme.colors.mut}>
            {elapsed}
          </Text>
        </View>
        <Text size={15.5} weight={600} numberOfLines={2}>
          {run.title}
        </Text>
        <RunProgressBar progress={run.progress} height={6} style={{ marginVertical: 2 }} />
        {run.now ? (
          <Text size={13.5} lh={1.4} color={theme.colors.ink2} numberOfLines={1}>
            {run.now}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, marginTop: -4 }}>
        <View style={{ flex: 1 }}>
          <RunChipsView chips={run.chips} />
        </View>
        <Touchable
          onPress={onWatch}
          feedback="wash"
          accessibilityRole="link"
          accessibilityLabel={tMobile('screens2.chat.watchRun', { title: run.title })}
          ringRadius={10}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
        >
          <Text size={13.5} weight={500} color={theme.colors.brand}>
            {run.link}
          </Text>
        </Touchable>
        <Touchable
          onPress={onOpen}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={tMobile('ui.show-card')}
          accessibilityState={{ expanded: false }}
          ringRadius={12}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 }}
        >
          <ChevronDown size={18} color={theme.colors.mut} strokeWidth={2} />
        </Touchable>
      </View>
    </View>
  );
}

// Up and back down in 1.2 s, each half eased as `Animated.timing` eases by default; the middle dot the other way round.
const PULSE_OUTER = pulseRange(0.35, 0.9, Easing.inOut(Easing.ease));
const PULSE_MIDDLE = pulseRange(0.9, 0.35, Easing.inOut(Easing.ease));

/** Three small pulsing dots: an agent thinking (the thinking row's, AP-706; a thread's reply row, AP-735). */
export function PulseDots({ size = 7, gap = 5 }: { size?: number; gap?: number }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    // One timing, so the loop runs on the display thread (a loop of a sequence is restarted from JavaScript).
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  return (
    <View style={{ flexDirection: 'row', gap }}>
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.colors.mut,
            opacity: pulse.interpolate(i === 1 ? PULSE_MIDDLE : PULSE_OUTER),
          }}
        />
      ))}
    </View>
  );
}

/**
 * A thread's reply row, as Slack's (docs/decisions/slack-thread-link.md AP-944): the last repliers' faces, `25 replies`
 * and `Last reply 2 hours ago`. In Chat and Feedback (`room`) every first message has it — “No replies yet” before the
 * first reply — and where the thread stands comes only from its flags (`stage`, docs/decisions/chat-threads-cards.md):
 * “● Waiting for you” (a `chart1` dot, so it isn't read as a health dot; AP-7417), “◌ Neo is working”, “⑂ Handed over”,
 * “✓ Settled”, in place of when the last reply came. Elsewhere, while there is work in the thread (card-settle.md
 * AP-735) the agent's face with `Dusty is working · 38%` and a small bar, `Dusty needs you` in warn, or `Dusty is
 * thinking` with the dots, in place of the last reply (a phone is too narrow for both). The whole row opens the thread.
 */
export function ThreadRepliesRow({
  replies,
  heads,
  lastAt,
  work,
  onOpen,
  onPressIn,
  isNew = false,
  stage = null,
  assistant = '',
  room = false,
  jobLine = null,
}: {
  /** `25 replies`; null before the first reply. */
  replies: string | null;
  /** The last repliers, up to three. */
  heads: readonly Principal[];
  /** When the last reply came: `Last reply 2 hours ago`, on the clock. */
  lastAt: string | null;
  work: ThreadWorkView | null;
  onOpen: () => void;
  /** The finger is down on it: the thread can start loading before it opens. */
  onPressIn?: () => void;
  /** Something in the thread is new to the person (Whombat thread-unread.md): an 8dp brand dot first in the row. */
  isNew?: boolean;
  /**
   * Where the thread stands by its flags (`threadStage`); waiting opens the thread at its end, where the card waits.
   * Null: nothing goes on, the row says its replies and when the last came.
   */
  stage?: ThreadStage | null;
  /** The assistant's name, for “Neo is working”. */
  assistant?: string;
  /** A thread of Chat or Feedback: “No replies yet” before the first reply. */
  room?: boolean;
  /**
   * Who is at work from the thread and how far along (a council, a checklist, T3 Code; `threadWorkLine`), on its own
   * line under the replies, in place of “Handed over”.
   */
  jobLine?: WorkLine | null;
}) {
  const { rawLocale } = useI18n();
  const threadStageWordsHere = threadStageWords(rawLocale);
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  // The job's line says what “Handed over” said, and what waits for the person when that is its work.
  const shownStage =
    jobLine && (stage === 'handedOver' || (stage === 'waiting' && jobLine.tone === 'warn')) ? null : stage;
  const jobSpoken = useWorkLineSpoken(jobLine);
  // In a room the stage says what goes on; the work line stays for what has no flag (a run that needs the person).
  const workLine = work && !(room && stage) ? work : null;
  const workText = workLine ? (workLine.line ?? `${workLine.name} ${workLine.text}`) : null;
  // Its own clock: the row re-renders when the words change, not the conversation's list.
  const last = useNowLabel(
    (now) => (lastAt ? lastReplyText(lastAt, now, timeZone, rawLocale) : null),
    (now) => !!lastAt && !work && lastReplyFollowsClock(lastAt, now),
  );
  const lastText = workLine || stage ? null : last;
  // The unread dot never shows on a settled thread (TU-05).
  const fresh = isNew && !!replies && stage !== 'settled';
  const count = replies ?? (room ? threadStageWordsHere.noReplies : null);
  const label = [
    threadRowLabel({
      replies: [count, lastText, workLine ? (workLine.spoken ?? workText) : null].filter(Boolean).join(', '),
      stage: shownStage,
      assistant,
      unread: fresh ? threadNewLabel(rawLocale) : null,
      locale: rawLocale,
    }),
    jobSpoken,
  ]
    .filter(Boolean)
    .join(', ');
  const rowStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as const;
  const content = (
    <>
      {fresh ? (
        // First in the row, so it reads as a mark and not as a separator between the words.
        <View
          testID="thread-new"
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.brand }}
        />
      ) : null}
      {replies && heads.length ? (
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {heads.map((p) => (
            <PrincipalAvatar key={p.id} principal={p} size={20} />
          ))}
        </View>
      ) : null}
      {count ? (
        <Text size={13} weight={600} color={theme.colors.brand}>
          {count}
        </Text>
      ) : null}
      {shownStage ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          {count ? (
            <Text size={12.5} color={theme.colors.mut}>
              ·
            </Text>
          ) : null}
          <StageMark stage={shownStage} />
          <Text
            size={12.5}
            weight={shownStage === 'settled' ? 500 : 600}
            color={
              shownStage === 'waiting'
                ? theme.colors.warnText
                : shownStage === 'settled'
                  ? theme.colors.mut
                  : theme.colors.ink
            }
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {threadStageWord(shownStage, assistant, rawLocale)}
          </Text>
          {/* How far a run in it is, and how long T3 Code has had it: the work's own facts after the stage. */}
          {shownStage === 'working' && work && work.progress !== null ? (
            <RunProgressBar progress={work.progress} style={{ width: 40 }} />
          ) : shownStage === 'handedOver' && work?.by && work.since != null ? (
            <HandoffMinutesText since={work.since} />
          ) : null}
        </View>
      ) : null}
      {lastText ? (
        <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
          {lastText}
        </Text>
      ) : null}
      {workLine ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          {workLine.by === 't3code' ? (
            <T3Tile live={workLine.tone === 'live'} warn={workLine.tone === 'warn'} />
          ) : (
            <PrincipalAvatar principal={workLine.agent} size={18} />
          )}
          <Text
            size={12.5}
            weight={workLine.tone === 'warn' ? 600 : 500}
            color={workLine.tone === 'warn' ? theme.colors.warnText : theme.colors.mut}
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {workText}
          </Text>
          {workLine.progress !== null ? (
            <RunProgressBar progress={workLine.progress} style={{ width: 40 }} />
          ) : workLine.tone === 'live' &&
            (workLine.text === clientTranslator(rawLocale).t('working.isThinking') ||
              workLine.text === handoffWords(rawLocale).answering) ? (
            <PulseDots size={4} gap={3} />
          ) : workLine.by && workLine.since != null ? (
            <HandoffMinutesText since={workLine.since} />
          ) : null}
        </View>
      ) : null}
    </>
  );
  return (
    <Touchable
      onPress={onOpen}
      onPressIn={onPressIn}
      feedback="fade"
      accessibilityRole="link"
      accessibilityLabel={label}
      ringRadius={10}
      style={{
        minHeight: Platform.OS === 'android' ? 48 : 44,
        ...(jobLine ? { justifyContent: 'center', gap: 6, paddingVertical: 6 } : rowStyle),
        alignSelf: jobLine || workLine || (room && stage) ? 'stretch' : 'flex-start',
        paddingHorizontal: 4,
        marginVertical: -8,
      }}
    >
      {jobLine ? (
        <>
          <View style={rowStyle}>{content}</View>
          <WorkLineRow line={jobLine} />
        </>
      ) : (
        content
      )}
    </Touchable>
  );
}

/**
 * A thread's stage mark, decoration beside its words: waiting a filled 8dp `chart1` dot (not a health colour), working
 * an open ring, handed over the branch arrow, settled a tick — all in the line's own colour but waiting's.
 */
export function StageMark({ stage }: { stage: ThreadStage }) {
  const theme = useTheme();
  const hidden = {
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  } as const;
  if (stage === 'waiting')
    return (
      <View
        {...hidden}
        testID="stage-waiting"
        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.chart.chart1 }}
      />
    );
  if (stage === 'working')
    return (
      <View
        {...hidden}
        testID="stage-working"
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: theme.colors.mut,
          borderTopColor: 'transparent',
          transform: [{ rotate: '45deg' }],
        }}
      />
    );
  const Icon = stage === 'handedOver' ? GitBranch : Check;
  return (
    <View {...hidden} testID={`stage-${stage}`}>
      <Icon size={12} color={theme.colors.mut} strokeWidth={2.25} />
    </View>
  );
}

/**
 * “Load earlier replies” under a thread's root (contracts 0.55, MX-09): the replies before the oldest shown, a page at a
 * time. A 44dp text button in `brand`, `mut` while the page loads.
 */
export function LoadEarlierRow({
  label,
  busy,
  onPress,
  pageSize,
}: {
  label: string;
  busy: boolean;
  onPress: () => void;
  pageSize: number;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={busy}
      accessibilityHint={tMobile('screens2.chat.earlierHint', { count: pageSize })}
      accessibilityState={{ busy }}
      feedback="wash"
      ringRadius={10}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        paddingHorizontal: 4,
        borderRadius: 10,
      }}
    >
      <ChevronUp size={16} color={busy ? theme.colors.mut : theme.colors.brand} strokeWidth={2} />
      <Text size={13.5} weight={600} color={busy ? theme.colors.mut : theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * Under the words of a message whose council or Tasks card moved to the thread's end (Whombat card-moves.md CM-07):
 * one quiet line, “The Tasks card is further down ↓”, that takes the thread to the card. Muted and small like the row's
 * other notes; the line is 44dp tall to tap and pulled into the row's gaps so it doesn't look it.
 */
export function MovedCardLinkView({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="link"
      accessibilityLabel={label}
      ringRadius={8}
      testID="moved-card-link"
      style={{
        minHeight: 44,
        marginVertical: -8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        paddingHorizontal: 4,
        marginHorizontal: -4,
        borderRadius: 8,
      }}
    >
      <Text size={13} color={theme.colors.mut}>
        {label}
      </Text>
      <ArrowDown size={14} color={theme.colors.mut} strokeWidth={1.8} />
    </Touchable>
  );
}

/**
 * Where the person talked about a council's or Tasks card that has since moved on (Whombat card-moves.md): one
 * quiet line, “Tasks · earlier version · 5 tasks”, that opens the card as it was here, read-only (no touches reach it and
 * screen readers hear it in words), and “Newest ↓” that takes the thread to the card now. Only the newest card has buttons.
 */
export function EarlierCardView({
  line,
  spoken = null,
  newest,
  children,
}: {
  line: string;
  /** The copy read out (`earlierCardText`). */
  spoken?: string | null;
  newest: { label: string; onPress: () => void } | null;
  children: ReactNode;
}) {
  const { rawLocale } = useI18n();
  const movedCardWordsHere = movedCardWords(rawLocale);
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignSelf: 'stretch', gap: 6 }} testID="earlier-card">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12 }}>
        <Touchable
          onPress={() => setOpen((o) => !o)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${line}. ${open ? movedCardWordsHere.hide : movedCardWordsHere.show}`}
          ringRadius={8}
          style={{
            minHeight: 44,
            marginVertical: -6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexShrink: 1,
            paddingHorizontal: 4,
            marginHorizontal: -4,
            borderRadius: 8,
          }}
        >
          <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}>
            <ChevronDown size={15} color={theme.colors.mut} strokeWidth={2} />
          </View>
          <Text size={13} color={theme.colors.ink2} style={{ flexShrink: 1 }}>
            {line}
          </Text>
        </Touchable>
        {newest ? (
          <Touchable
            onPress={newest.onPress}
            feedback="wash"
            accessibilityRole="link"
            accessibilityLabel={`${movedCardWordsHere.newest}: ${newest.label}`}
            ringRadius={8}
            testID="moved-card-link"
            style={{
              minHeight: 44,
              marginVertical: -6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 4,
              borderRadius: 8,
            }}
          >
            <Text size={13} color={theme.colors.mut}>
              {movedCardWordsHere.newest}
            </Text>
            <ArrowDown size={14} color={theme.colors.mut} strokeWidth={1.8} />
          </Touchable>
        ) : null}
      </View>
      {open ? (
        // Screen readers hear the copy in words (`spoken`); what is drawn takes no touches and isn't read again.
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={spoken ?? line}
          style={{ alignSelf: 'stretch' }}
        >
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {children}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const NO_TARGETS: readonly MentionTarget[] = [];
const NO_ADDS: readonly AddChoice[] = [];

/**
 * The box's “+”: what can go in a message, in one place. iPhone: iOS's own menu from the button; elsewhere a sheet,
 * whose pick waits until it is down on iOS (a screen it opens can't show under it).
 */
function PlusButton({
  choices,
  onPick,
  disabled,
}: {
  choices: readonly AddChoice[];
  onPick: ((id: string) => void) | undefined;
  disabled: boolean | undefined;
}) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const after = useAfterSheet();
  const label = plusLabel(
    choices.map((c) => c.id),
    rawLocale,
  );
  const face = <Plus size={20} color={theme.colors.ink2} strokeWidth={1.75} />;
  const round = {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  if (hasNativeMenu && !disabled)
    return (
      <NativeMenu
        spec={{
          title: null,
          reactions: null,
          more: null,
          sections: [choices.map((c) => ({ id: c.id, title: c.label, icon: c.symbol }))],
        }}
        onPick={(id) => onPick?.(id)}
        trigger="tap"
        label={label}
        style={round}
      >
        <View style={round}>{face}</View>
      </NativeMenu>
    );
  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        feedback="wash"
        ringRadius={16}
        hitSlop={hitSlopFor(32)}
        style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
      >
        {face}
      </Touchable>
      <AddSheet
        visible={open}
        choices={choices}
        label={label}
        onClose={() => setOpen(false)}
        onDismissed={after.onDismissed}
        onPick={(id) => {
          setOpen(false);
          if (Platform.OS === 'ios') after.later(() => onPick?.(id));
          else onPick?.(id);
        }}
      />
    </>
  );
}

/**
 * After a correction replaced the text (same length), the caret goes back where it was: the field may otherwise move
 * it to the end when the new text arrives.
 */
export function keepCaret(field: { current: TextInput | null }, caret: number): void {
  requestAnimationFrame(() => field.current?.setSelection(caret, caret));
}

/**
 * Pill composer: "Ask Dusty anything", 46dp, radius 23, send button on the right. With `adds`, one “+” on the left opens
 * what can go in (a photo or a file, the saved prompts: iOS's own menu on iPhone, a sheet elsewhere); files' chips sit
 * above the pill, and Send works with files alone once they are up. Return
 * types a new line (lists, code blocks, paragraphs) and the button sends (MX-02). What is typed is handed to
 * `onTextChange` (the kept draft) and `keptDraft` comes back into an empty composer. With `voice`, the mic of voice
 * typing before Send (docs/decisions/dictation.md DT-01): while it records the pill is the recording bar, and the words
 * go in at the cursor, never sent by themselves; a failure shows under the pill for a moment. `above` draws over the pill
 * from the text (the prompts a `/` word matches).
 */
export function Composer({
  placeholder,
  onSend,
  disabled,
  adds = NO_ADDS,
  onAdd,
  attachments = [],
  onRemoveAttachment,
  onRetryAttachment,
  canRetryAttachment = () => true,
  fill = null,
  mentionTargets = NO_TARGETS,
  keptDraft = '',
  onTextChange,
  tool = null,
  voice: voiceSource = null,
  voiceKey,
  note = null,
  focusKey = 0,
  above,
}: {
  placeholder: string;
  /**
   * Over the pill, from what is typed: the person's prompts that match a `/` word (prompts-phone.md); nothing while voice
   * typing records.
   */
  above?: (text: string) => ReactNode;
  /** Under the reply box, quietly: “A reply opens it again.” in a settled thread (chat-settle.md AP-6154). */
  note?: string | null;
  /** A new number puts the cursor in the box (a new chat the person asked for); 0 leaves it where it is. */
  focusKey?: number;
  /** Sends the text. */
  onSend: (text: string) => void;
  disabled?: boolean;
  /** What the “+” offers: the photo / file choices (docs/decisions/bp-attachments.md), the saved prompts; none, no “+”. */
  adds?: readonly AddChoice[];
  onAdd?: (id: string) => void;
  attachments?: readonly UploadItem[];
  onRemoveAttachment?: (localId: string) => void;
  onRetryAttachment?: (localId: string) => void;
  /** Whether a failed chip offers Retry (not for a file that can never go up as it is). */
  canRetryAttachment?: (localId: string) => boolean;
  /** Puts this text in the composer (a suggestion, AP-231); a new `seq` fills it again. */
  fill?: { text: string; seq: number } | null;
  /** Who `@Name` means: `@neo ` is corrected to `@Neo ` as it is typed (AP-607, Whombat MS-C03). */
  mentionTargets?: readonly MentionTarget[];
  /** What was typed here and not sent (MX-02): shown when the composer is still empty. */
  keptDraft?: string;
  /** Every change of the text, to keep it as the draft. */
  onTextChange?: (text: string) => void;
  /** In the pill before the “+”: the Chat's “what answers” icon (chat-runtime-icon.md AP-2962). */
  tool?: ReactNode;
  /** Where voice typing's recordings go; null: no mic. */
  voice?: VoiceSource | null;
  /** Which draft this is (a conversation, a thread): a recording for another one is dropped. Default `placeholder`. */
  voiceKey?: string;
}) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [text, setText] = useState(keptDraft);
  // The latest text, ahead of React's re-render: two quick changes (Enter picking a mention, then another key) must read
  // the text the first one left, and a send clears it at once.
  const draft = useRef(keptDraft);
  const field = useRef<TextInput>(null);
  useEffect(() => {
    if (!fill) return;
    draft.current = fill.text;
    setText(fill.text);
    // Words put in are for writing on; an emptied box (a prompt sent for the person) leaves the keyboard as it is.
    if (fill.text) field.current?.focus();
  }, [fill]);
  useEffect(() => {
    if (focusKey) field.current?.focus();
  }, [focusKey]);
  // A draft read from the device after this opened goes in, unless something was typed meanwhile (MX-02).
  useEffect(() => {
    if (!keptDraft || draft.current) return;
    draft.current = keptDraft;
    setText(keptDraft);
  }, [keptDraft]);
  const textChanged = useRef(onTextChange);
  textChanged.current = onTextChange;
  useEffect(() => {
    textChanged.current?.(text);
  }, [text]);
  // Where the cursor is, for the words voice typing puts in.
  const selection = useRef({ start: keptDraft.length, end: keptDraft.length });
  const voice = useComposerVoice(voiceSource, {
    ownerKey: voiceKey ?? placeholder,
    text,
    selection: () => selection.current,
    commit: (next, at) => {
      draft.current = next;
      selection.current = at;
      setText(next);
      keepCaret(field, at.start);
    },
  });
  const listening = voice.active;
  const sendable = canSend(text, attachments);
  const send = () => {
    const value = draft.current.trim();
    if (disabled || listening || !canSend(value, attachments)) return;
    draft.current = '';
    haptic('send');
    onSend(value);
    setText('');
  };
  const input = textMetrics({ size: 15.5 });
  // A long message grows the box up to 40 % of the screen, then scrolls inside it, so it can be read back.
  const maxHeight = composerMaxHeight(useWindowDimensions().height);
  const resting = !text && attachments.length === 0 && !listening;
  const plus = adds.length > 0 && !!onAdd;
  return (
    <ComposerBar resting={resting}>
      {above && !listening ? above(text) : null}
      {onRemoveAttachment && onRetryAttachment ? (
        <UploadChips
          items={attachments}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
          canRetry={canRetryAttachment}
        />
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 46,
          paddingLeft: tool || plus ? 7 : 16,
          paddingRight: 8,
          borderRadius: 23,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
        }}
      >
        {listening ? <VoiceBar voice={voice} /> : null}
        {(tool || plus) && !listening ? (
          // The icons sit closer to each other than to the field (the mockup's 4dp).
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {tool}
            {plus ? <PlusButton choices={adds} onPick={onAdd} disabled={disabled} /> : null}
          </View>
        ) : null}
        <TextInput
          ref={field}
          value={text}
          onChangeText={(v) => {
            const fixed = autocorrectComposerMention({ previous: draft.current, next: v }, mentionTargets);
            draft.current = fixed?.text ?? v;
            setText(draft.current);
            if (fixed) keepCaret(field, fixed.caret);
          }}
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.mut}
          // VoiceOver reads the placeholder itself; a label the same would say it twice.
          accessibilityLabel={Platform.OS === 'ios' ? undefined : placeholder}
          multiline
          submitBehavior="newline"
          editable={!disabled}
          selectionColor={theme.colors.brand}
          cursorColor={theme.colors.ink}
          style={{
            // Kept while voice typing records (its text and cursor stay), out of sight.
            display: listening ? 'none' : 'flex',
            flex: 1,
            maxHeight,
            paddingVertical: 11,
            paddingHorizontal: 0,
            color: theme.colors.ink,
            fontFamily: input.fontFamily,
            fontSize: input.fontSize,
            lineHeight: input.lineHeight,
            includeFontPadding: false,
            textAlignVertical: 'center',
          }}
        />
        {listening ? null : (
          <>
            <MicButton voice={voice} disabled={disabled} />
            <Touchable
              onPress={send}
              accessibilityLabel={tClient('reports.send')}
              accessibilityHint={
                attachments.some((a) => a.state === 'uploading')
                  ? tMobile('ui.waits-for-the-upload-to-finish')
                  : undefined
              }
              accessibilityState={{ disabled: !sendable }}
              ringRadius={16}
              hitSlop={hitSlopFor(32)}
              style={{ width: 32, height: 32, borderRadius: 16, ...sendLook(theme, sendable).box }}
            >
              <ArrowUp size={18} color={sendLook(theme, sendable).arrow} strokeWidth={2.25} />
            </Touchable>
          </>
        )}
      </View>
      {voice.error ? (
        <Text
          size={13}
          lh={1.4}
          color={theme.colors.bad}
          accessibilityLiveRegion="polite"
          style={{ paddingTop: 6 }}
        >
          {voice.error}
        </Text>
      ) : null}
      {note ? (
        <Text size={12} lh={1.4} color={theme.colors.mut} style={{ paddingTop: 6, paddingHorizontal: 8 }}>
          {note}
        </Text>
      ) : null}
    </ComposerBar>
  );
}

/**
 * The bar a reply box sits in: a hairline over it, the room the gesture area or the tab bar needs under it, and on the
 * keyboard while that is up, moving with it. With two pages it is as tall as the tallest bar at rest, so the lines over
 * the boxes meet across the divider; `resting` says whether what is in it is at rest now (nothing typed, attached or
 * recording).
 */
function ComposerBar({ resting, children }: { resting: boolean; children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Our bottom tab bar keeps the system's area under the box itself; iOS's own bar covers the screen's bottom, so the
  // box sits on it; elsewhere (a page of its own, a tab beside the side tabs) the screen reaches the window's bottom.
  const below = useBelowScreen();
  const glassRoom = useContext(GlassBarRoomContext);
  const composerBelow: BelowComposer = below === 'edge' ? 'nothing' : below;
  const line = useContext(ComposerLineContext);
  const report = line?.report;
  const id = useId();
  useEffect(() => (report ? () => report(id, null) : undefined), [report, id]);
  const rest = composerBottomPadding(insets.bottom, composerBelow, glassRoom);
  // With the keyboard up the gesture area is under it: the box sits on the keyboard, and travels with it.
  const padding = useKeyboardPadding(rest, ABOVE_KEYBOARD);
  const inner = useRef(0);
  const reportRest = () => {
    if (report && resting && inner.current) report(id, inner.current + 10 + rest + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is in the bar reports through its own layout
  useEffect(reportRest, [rest]);
  return (
    <Reanimated.View
      style={[
        {
          paddingHorizontal: 14,
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          backgroundColor: theme.colors.bg,
        },
        padding,
      ]}
    >
      {/* The bars line up at rest; the keyboard takes only the room under the box, so nothing grows over it. */}
      <View
        style={{
          minHeight: line ? line.height - rest - 1 : undefined,
          justifyContent: 'flex-end',
          paddingTop: 10,
        }}
      >
        <View
          onLayout={(e) => {
            inner.current = e.nativeEvent.layout.height;
            reportRest();
          }}
        >
          {children}
        </View>
      </View>
    </Reanimated.View>
  );
}
