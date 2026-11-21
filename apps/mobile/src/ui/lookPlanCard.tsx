/**
 * A thing's plan on the phone (Whombat handle-it.md; contracts 3.11), as on the web: a card tinted in the look's colour
 * (green once done, grey once no longer needed) with the assistant's title and words, “Here’s what I’ll do on pve-01:”,
 * its steps, then Go ahead (filled; the person's yes for exactly those steps) and Change something (words only; the
 * thread, to reply). While it takes them it says it is on it; once done, the steps ticked. The thing's page draws it
 * with its title; in the thread the message above already says what it found, so the card starts at its list.
 */
import { type LookPlanCardView, lookFixOutcomeText, threadToOpen } from '@whombat/client';
import { useFixLook } from '@whombat/client/react';
import type { LookResearch } from '@whombat/core';
import { View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { openHref } from '../navigation/hooks';
import { showLookFix } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { toneOf } from './assistant';
import { tint } from './glanceColors';
import { Check } from './icons';
import { LookSays } from './LookSays';
import { Button } from './primitives';

export function LookPlanCard({
  view,
  research,
  variant,
  tone = 'warn',
  onChange,
}: {
  view: LookPlanCardView;
  /** The live research Go ahead sends; none: nothing to press. */
  research: LookResearch | null;
  variant: 'page' | 'thread';
  /** The look's colour while it waits (`bad` for a thing that is down or in trouble). */
  tone?: 'warn' | 'bad';
  /** Change something: the thread, to reply. */
  onChange: () => void;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  // On a page Go ahead opens the thread, where the steps are taken (backup-places.md BPL-15); in the thread it stays.
  const { mutate: goAhead, isPending } = useFixLook(slug, (outcome, thread) => {
    const text = lookFixOutcomeText(outcome);
    if (text) showLookFix(outcome, text);
    const open = variant === 'page' ? threadToOpen(thread) : null;
    if (open) openHref(open);
  });
  const color = toneOf(theme, view.done ? 'ok' : view.state === 'gone' ? null : tone);
  // In the thread the message above says what it found; once done or while it works, its words are the news.
  const words = variant === 'page' || view.state !== 'waiting';
  return (
    <View
      accessibilityLabel={view.title ?? view.head}
      style={{
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: tint(color, 0.45),
        backgroundColor: tint(color, 0.08),
      }}
    >
      {words && view.title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }}
          />
          <Text
            size={17}
            weight={700}
            lh={1.3}
            tracking={-0.01}
            accessibilityRole="header"
            style={{ flex: 1 }}
          >
            {view.title}
          </Text>
        </View>
      ) : null}
      {words && view.text ? (
        <LookSays view={{ text: view.text, busy: view.busy }} size={22} textSize={14.5} />
      ) : null}
      <Text size={14} weight={600} lh={1.4}>
        {view.head}
      </Text>
      <View style={{ gap: 6 }}>
        {view.steps.map((step, i) => (
          <View
            // A plan's steps have no ids; their order is the plan's.
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are the plan's own order
            key={i}
            accessible
            accessibilityLabel={view.done ? `${step} (done)` : step}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}
          >
            <View style={{ width: 16, height: 20, alignItems: 'center', justifyContent: 'center' }}>
              {view.done ? (
                <Check size={14} color={theme.colors.ok} strokeWidth={2.2} />
              ) : (
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
              )}
            </View>
            <Text
              size={14}
              lh={1.45}
              color={view.state === 'gone' ? theme.colors.mut : theme.colors.ink2}
              style={{ flex: 1 }}
            >
              {step}
            </Text>
          </View>
        ))}
      </View>
      {view.goAhead || view.change ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
          {view.goAhead && research ? (
            <Button
              label={view.goAhead}
              variant="primary"
              busy={isPending}
              onPress={() => goAhead(research)}
              style={{ flexGrow: 1 }}
            />
          ) : null}
          {view.change ? (
            <Button
              label={view.change}
              variant="quiet"
              onPress={onChange}
              style={{ flexGrow: 1, borderWidth: 0 }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
