/**
 * The assistant's AI sign-in (less-is-more.md AP-1814…AP-1816; was Settings → AI, SUB-11, SS-03): one sentence, then a
 * card per provider — its name and state dot, “Signed in · Max plan”, the 5-hour and 7-day meters, “Sign in on the web”
 * where it isn't signed in — with how it is signed in, the client's version and when the usage was read under Details.
 * Sign-ins and usage are read when it opens (sign-ins every 30 s while open); nothing shows while they load or where
 * the Whombat has neither. What else runs AI here — “A model on your network” (`LocalModelCard`, hermes-engine-app.md
 * AP-5124), web search (`WebSearchCard`) and a managed Whombat's own AI — is Advanced's “AI on this Whombat”; Spend
 * is Advanced's too, in one place.
 */

import { applianceLink } from '@whombat/client/managed';
import { queryHook, useClients, useSignIns, useWhombat } from '@whombat/client/react';
import { aiAccountsPath, clientInstalled, clientOf, needsClient } from '@whombat/client/signins';
import { api } from '@whombat/core/contracts';
import { Fragment, useMemo } from 'react';
import { Linking, View } from 'react-native';
import { useBurrow, useBurrowBase, useNow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { AiProviders } from '../managed/AiProviders';
import { AiSignInCard } from '../managed/AiSignIn';
import { UI_ORIGINS } from '../managed/config';
import { useManaged } from '../managed/context';
import { Meter } from '../managed/HostCharts';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FoldText, MoreFold } from '../ui/fold';
import { Button, StatusDot } from '../ui/primitives';
import { AI_TEXT, type AiProviderCardView, type AiTone, aiProviderCards, meterLabel } from './ai';
import { LocalModelCard } from './LocalModelCard';
import { WebSearchCard } from './WebSearchCard';

const useUsageList = queryHook(api.usage.list);

function toneColor(theme: ReturnType<typeof useTheme>, tone: AiTone): string {
  return tone === 'ok'
    ? theme.colors.ok
    : tone === 'warn'
      ? theme.colors.warn
      : tone === 'bad'
        ? theme.colors.bad
        : theme.colors.mut;
}

/**
 * The provider cards from the sign-ins, the clients and the usage; undefined until the sign-ins answered. The AI page
 * reads the sign-ins every 30 s while it shows; the Settings list and the tab's dot once (settings-tab-android.md AP-2623).
 */
export function useAiProviderCards(
  refetchInterval: number | false = false,
): AiProviderCardView[] | undefined {
  // Not the bootstrap: the tab bar's dot reads this, and every new message changes the bootstrap.
  const { slug, timeZone } = useBurrowBase();
  const signIns = useSignIns({}, { retry: false, refetchInterval });
  const clients = useClients({}, { retry: false });
  const usage = useUsageList({ params: { burrow: slug } }, { retry: false });
  const now = useNow().getTime();
  return useMemo(
    () =>
      signIns.data
        ? aiProviderCards({
            signIns: signIns.data.signIns,
            clients: clients.data?.clients,
            usage: usage.data?.mine,
            now,
            timeZone,
          })
        : undefined,
    [signIns.data, clients.data, usage.data, now, timeZone],
  );
}

/**
 * Where people sign in to their AI (SUB-11): this burrow's AI sign-in on the hosted app; none in the demo world or on a
 * community box, which has no hosted app to open (AP-5470).
 */
function useAiWebUrl(): string | null {
  const { bootstrap } = useBurrow();
  const managed = useManaged();
  if (!managed || managed.community) return null;
  return applianceLink(
    UI_ORIGINS[0] ?? 'https://app.whombat.com',
    managed.applianceId,
    aiAccountsPath(bootstrap.burrow.slug),
  );
}

/**
 * The AI sign-in: one sentence, then a card per provider; one that isn't signed in (or stopped working) gets the
 * phone's own sign-in under it (first-day.md: ChatGPT's code, Claude Code's paste-the-code, in the in-app browser).
 */
export function AiSignIns() {
  const theme = useTheme();
  const words = useAgentWords();
  const webUrl = useAiWebUrl();
  const cards = useAiProviderCards(30_000) ?? [];
  const { client } = useWhombat();
  const clients = useClients({}, { retry: false });
  const signIns = useSignIns({}, { retry: false });
  const changed = () => {
    void signIns.refetch();
    void clients.refetch();
  };
  return (
    <>
      <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {AI_TEXT.help(words.Name)}
      </Text>
      {cards.map((c) => (
        <Fragment key={c.provider}>
          <ProviderCard card={c} webUrl={c.signIn ? null : webUrl} />
          {c.signIn ? (
            <AiSignInCard
              provider={c.provider}
              client={client}
              ready={false}
              installed={!needsClient(c.provider) || clientInstalled(clientOf(clients.data, c.provider))}
              installing={clientOf(clients.data, c.provider)?.state === 'installing'}
              onChanged={changed}
            />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

/** Advanced → AI on this Whombat: a model on your network, web search and, on a Whombat, the AI it has itself. */
export function AiOnThisWhombat() {
  const managed = useManaged();
  return (
    <>
      <LocalModelCard />
      <WebSearchCard />
      {managed ? <AiProviders /> : null}
    </>
  );
}

function ProviderCard({ card, webUrl }: { card: AiProviderCardView; webUrl: string | null }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 6,
        gap: 10,
      }}
    >
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={card.label}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <StatusDot color={toneColor(theme, card.tone)} label={card.status} />
        <Text size={15.5} weight={600} style={{ flexShrink: 0 }}>
          {card.name}
        </Text>
        <Text size={13} color={theme.colors.mut} numberOfLines={1} style={{ flex: 1, textAlign: 'right' }}>
          {card.status}
        </Text>
      </View>
      {card.meters.map((m) => (
        <View key={m.key} accessible accessibilityLabel={meterLabel(m)} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text size={12.5} mono color={theme.colors.ink2}>
              {m.label}
            </Text>
            <Text size={12.5} mono color={m.word ? toneColor(theme, m.tone) : theme.colors.ink2}>
              {[m.pctText, m.word].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Meter pct={m.pct} />
          {m.resets ? (
            <Text size={12} color={theme.colors.mut}>
              {m.resets}
            </Text>
          ) : null}
        </View>
      ))}
      {card.note ? (
        <Text size={13} lh={1.45} color={card.trouble ? theme.colors.ink2 : theme.colors.mut}>
          {card.note}
        </Text>
      ) : null}
      {card.signIn && webUrl ? (
        <Button
          label={`Sign in to ${card.name} on the web`}
          variant="secondary"
          accessibilityHint={webUrl}
          onPress={() => void Linking.openURL(webUrl)}
        />
      ) : null}
      {card.details.length ? (
        <MoreFold label={AI_TEXT.details} open={card.trouble}>
          {card.details.map((d) => (
            <FoldText key={d}>{d}</FoldText>
          ))}
        </MoreFold>
      ) : (
        <View style={{ height: 8 }} />
      )}
    </View>
  );
}
