/**
 * What the assistant found out about what needs a look here (Whombat look-research.md LR-08, LR-09; contracts 3.5
 * `ThingPage.research`; look-research-mobile.md AP-5923), at the top of the Summary as on the web: a card tinted in the
 * look's colour (green once fixed) with the look's dot and the assistant's title, its words by its face, the step it
 * offers (filled) and Ask {assistant} (words only), which opens the look's thread, or asks about the thing without
 * one. While it looks, the line alone. A plan of several steps is the plan card (handle-it.md). On a connection's,
 * device's or server's page. Ignore stays in the line's ⋯ in Worth a look, which is the one it quiets.
 */
import { lookFixOutcomeText, threadToOpen } from '@whombat/client';
import { useFixLook } from '@whombat/client/react';
import type { ThingPage } from '@whombat/core';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { thingLookCard } from '../../data/thingPage';
import { useAgentWords } from '../../data/useAgent';
import { openHref } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { toneOf } from '../../ui/assistant';
import { tint } from '../../ui/glanceColors';
import { LookSays } from '../../ui/LookSays';
import { LookPlanCard } from '../../ui/lookPlanCard';
import { Button } from '../../ui/primitives';
import { showLookFix } from '../feedback';

export function LookCard({
  page,
  onAsk,
}: {
  page: Pick<ThingPage, 'research' | 'status' | 'name'>;
  /** Ask about the thing (its chat, or a new one) when the research has no thread. */
  onAsk: () => void;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const assistant = useAgentWords().name;
  // The go-ahead opens the look's thread, where the step is taken (backup-places.md BPL-15).
  const { mutate: fix, isPending } = useFixLook(slug, (outcome, thread) => {
    const text = lookFixOutcomeText(outcome);
    if (text) showLookFix(outcome, text);
    const open = threadToOpen(thread);
    if (open) openHref(open);
  });
  const card = thingLookCard(page, assistant);
  if (!card) return null;
  const { view, research, thread } = card;
  if (card.plan)
    return (
      <LookPlanCard
        view={card.plan}
        research={research}
        variant="page"
        tone={card.planTone}
        onChange={() => (thread ? openHref(thread) : onAsk())}
      />
    );
  const color = toneOf(theme, card.tone);
  return (
    <View
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
      {view.title ? (
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
      <LookSays view={view} size={22} textSize={14.5} />
      {view.fix || view.ask ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
          {view.fix ? (
            <Button
              label={view.fix}
              variant="primary"
              busy={isPending}
              onPress={() => fix(research)}
              style={{ flexGrow: 1 }}
            />
          ) : null}
          {view.ask ? (
            <Button
              label={view.ask}
              variant="quiet"
              onPress={() => (thread ? openHref(thread) : onAsk())}
              style={{ flexGrow: 1, borderWidth: 0 }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
