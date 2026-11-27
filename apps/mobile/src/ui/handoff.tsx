/**
 * Work the agent handed to T3 Code, on the phone (docs/app/decisions/t3code-handoff.md AP-6610…AP-6617): T3 Code's mark
 * on an ink tile, the reply row's minute clock, and the line just above a thread's composer with what T3 Code does now,
 * its steps folded away (a tap folds them out) and a button that opens it in T3 Code. Not a message: nothing is posted,
 * and it goes once the agent answered.
 */
import {
  currentStep,
  handoffClock,
  handoffLine,
  handoffMinutes,
  handoffWords,
  threadHandoffs,
} from '@whombat/client';
import { useHandoffs } from '@whombat/client/react';
import { HANDOFF_COUNCIL_STEP, type Handoff } from '@whombat/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { useNow, useNowLabel } from '../data/BurrowProvider';
import { useI18n } from '../i18n';
import { useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { useReducedMotion } from './chat';
import { CouncilFaces } from './councilFaces';
import { ChevronDown, ChevronUp, ExternalLink } from './icons';
import { Touchable } from './Touchable';

/**
 * T3 Code's mark: its letters on an ink tile, as its own logo's white on black, in either theme. `live` breathes a halo
 * in the run line's green (still with reduced motion); `warn` adds the waiting dot.
 */
export function T3Tile({
  size = 18,
  live = false,
  warn = false,
}: {
  /** 24: a message's author mark, as the faces beside messages. */
  size?: 18 | 24 | 26;
  live?: boolean;
  warn?: boolean;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!live || reduced) return;
    const loop = Animated.loop(
      Animated.timing(breath, {
        toValue: 1,
        duration: theme.durations.liveTick,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, live, reduced, theme.durations.liveTick]);
  const radius = size === 18 ? 5 : size === 24 ? 6 : 7;
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {live ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: radius + 2,
            borderWidth: 2,
            borderColor: theme.status.working,
            opacity: reduced
              ? 0.7
              : breath.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.9, 0] }),
          }}
        />
      ) : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: theme.colors.ink,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <BrandMark mark="t3code" size={size === 18 ? 13 : size === 24 ? 16 : 18} color={theme.colors.bg} />
      </View>
      {warn ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            width: 8,
            height: 8,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: theme.colors.bg,
            backgroundColor: theme.status.waiting,
          }}
        />
      ) : null}
    </View>
  );
}

/** `· 6m` after the reply row's words, on the app's clock. */
export function HandoffMinutesText({ since }: { since: number }) {
  const theme = useTheme();
  const label = useNowLabel((now) => `· ${handoffMinutes(since, now.getTime())}`);
  return (
    <Text size={12} mono color={theme.colors.mut} accessibilityElementsHidden importantForAccessibility="no">
      {label}
    </Text>
  );
}

/** A clock that ticks each second while it shows. */
function useSeconds(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** The lines above a thread's composer, one per hand-over shown (`threadHandoffs`). */
export function HandoffBar({ handoffs, agentName }: { handoffs: readonly Handoff[]; agentName: string }) {
  if (!handoffs.length) return null;
  return (
    <View style={{ gap: 8, paddingHorizontal: 12, paddingBottom: 8 }} testID="handoffs">
      {handoffs.slice(0, 3).map((h) => (
        <HandoffLineRow key={h.id} handoff={h} agentName={agentName} />
      ))}
    </View>
  );
}

function HandoffLineRow({ handoff, agentName }: { handoff: Handoff; agentName: string }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const line = handoffLine(handoff, agentName, rawLocale);
  const [open, setOpen] = useState(false);
  const now = useSeconds(line.clockFrom !== null);
  const url = handoff.url;
  if (line.tone === 'done')
    return (
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 }}
        accessibilityRole="text"
        testID={`handoff-${handoff.state}`}
      >
        <T3Tile />
        <Text size={13} color={theme.colors.mut} style={{ flexShrink: 1 }}>
          {line.title}
        </Text>
      </View>
    );
  const warn = line.tone === 'warn';
  const step = currentStep(handoff);
  // While the thread's council reviews what T3 Code wasn't sure about, its faces stand in for T3 Code's mark.
  const council = !!step && step.text.trim().toLowerCase() === HANDOFF_COUNCIL_STEP;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: warn ? theme.colors.warn : theme.colors.line2,
        borderRadius: 12,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
      testID={`handoff-${handoff.state}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 10, paddingRight: 4 }}>
        <Touchable
          onPress={line.hasSteps ? () => setOpen((o) => !o) : undefined}
          disabled={!line.hasSteps}
          feedback="fade"
          accessibilityRole={line.hasSteps ? 'button' : 'text'}
          accessibilityState={line.hasSteps ? { expanded: open } : undefined}
          accessibilityLabel={[
            line.title,
            line.now,
            line.hasSteps
              ? open
                ? handoffWords(rawLocale).hideSteps
                : handoffWords(rawLocale).showSteps
              : null,
          ]
            .filter(Boolean)
            .join(', ')}
          style={{
            flex: 1,
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 9,
            paddingVertical: 8,
          }}
        >
          {council ? (
            <CouncilFaces size={18} overlap={9} ring={theme.colors.sf} />
          ) : (
            <T3Tile size={26} live={line.live} warn={warn} />
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text
                size={14}
                weight={600}
                color={warn ? theme.colors.warn : theme.colors.ink}
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {line.title}
              </Text>
              {line.clockFrom !== null ? (
                <Text size={12} mono color={theme.colors.mut}>
                  {handoffClock(line.clockFrom, now, rawLocale)}
                </Text>
              ) : null}
            </View>
            {line.now ? (
              // What T3 Code asks an OK for is read whole; what it does now stays one line.
              <Text size={13} color={theme.colors.mut} numberOfLines={line.tone === 'warn' ? 0 : 1}>
                {line.now}
              </Text>
            ) : null}
          </View>
          {line.hasSteps ? (
            open ? (
              <ChevronUp size={16} color={theme.colors.mut} />
            ) : (
              <ChevronDown size={16} color={theme.colors.mut} />
            )
          ) : null}
        </Touchable>
        {url ? (
          <Touchable
            onPress={() => openUrl(url)}
            feedback="wash"
            accessibilityRole="link"
            accessibilityLabel={handoffWords(rawLocale).openInT3Code}
            ringRadius={9}
            style={{
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: warn ? theme.colors.btn : theme.colors.line2,
                backgroundColor: warn ? theme.colors.btn : theme.colors.bg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ExternalLink size={15} color={warn ? theme.colors.btnfg : theme.colors.ink} />
            </View>
          </Touchable>
        ) : null}
      </View>
      {open ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            paddingVertical: 10,
            paddingRight: 12,
            paddingLeft: 45,
            gap: 6,
          }}
        >
          {line.meta ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {line.meta}
            </Text>
          ) : null}
          {handoff.steps.map((s, i) => {
            const now = s === step && !s.done;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the steps of one read never reorder
              <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
                <Text size={12} color={now ? theme.status.working : theme.colors.ok} style={{ width: 14 }}>
                  {now ? '●' : '✓'}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text size={13} color={theme.colors.ink2}>
                    {/* A step said in lower case for “Now: …” (the council's) starts the line as the others do. */}
                    {s.text.charAt(0).toUpperCase() + s.text.slice(1)}
                  </Text>
                  {s.detail ? (
                    <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
                      {s.detail}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The thread's own hand-overs above its composer: those from `rootId`, until the thread had a reply after an ended one
 * (`threadHandoffs`). `nameOf` names the agent that handed it over.
 */
export function ThreadHandoffBar({
  slug,
  conversationId,
  rootId,
  lastAt,
  nameOf,
}: {
  slug: string;
  conversationId: string | null;
  rootId: string;
  lastAt: string | null;
  nameOf: (principalId: string) => string;
}) {
  const all = useHandoffs(slug, conversationId);
  // An ended job's line goes after half an hour; the box keeps it for its receipt (job-view.md).
  const nowMs = useNow().getTime();
  const shown = useMemo(() => threadHandoffs(all, rootId, lastAt, nowMs), [all, rootId, lastAt, nowMs]);
  const first = shown[0];
  if (!first) return null;
  return <HandoffBar handoffs={shown} agentName={nameOf(first.agentId)} />;
}
