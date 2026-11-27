/**
 * One catalog connection on Android (Whombat docs/decisions/connections-catalog.md CX-72, CX-74; read-only): its logo
 * and label, CONNECTION (state and last check, who connected it, the check's warnings),
 * TOOLS with each tool's tier (Allowed / Asks / Off, “Always asks”, “New”) and what the agent is told about the
 * service. Where the runtime has levels (`connections.sign_in_once`, CT-314, AP-847) a tag says Look only or Manage.
 * You change it here (phone-connect.md PC-09, AP-2911): its name, what the agent may do, Check
 * again, a new key or password, Reconnect and Remove (`connect/ConnectionChanges.tsx`); tiers stay on the web. The
 * button that opened the web page went (on a managed Whombat the app caught that page itself). Nobody looks after a
 * connection (Whombat one-agent.md OA-07; AP-4991): the agent uses it.
 * An AI gateway (Fusebox or the generic one; Whombat ai-gateway.md AIG-01, AIG-05, AIG-06; AP-1123) has no
 * level or tools but CLAUDE CODE AND CODEX: which tools go through it and a switch per tool (Fusebox's asks first, with
 * the terms). WHAT WHOMBAT WATCHES (Whombat quiet-notices.md
 * QN-15; quiet-notices-mobile.md AP-4865) lists its checks with their switches and what is excepted, each with Undo;
 * read only for Look only. 1Password (Whombat onepassword-sync.md) has no level, tools or guide either, and Remove asks
 * whether the entries stay in the Vault; KEPT IN STEP and NOT IN YOUR VAULT are its page's own 1Password tab
 * (`connect/OnePassword.tsx`), not here. The Vault entry screen's language.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  aiGatewayOf,
  gatewayConfirm,
  gatewaySavedText,
  gatewaySwitches,
  gatewayText,
  gatewayUsedBy,
} from '@whombat/client';
import { codeSignInOf } from '@whombat/client/connections';
import { useConnectionTools, useQuietActions, useSetAiGateway, useThingWatch } from '@whombat/client/react';
import { catalogEntry, thingId as thingIdOf } from '@whombat/core';
import type { GatewayProvider } from '@whombat/core/domain';
import { useMemo, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrow, useViewContext } from '../data/BurrowProvider';
import { connectionDetail, connectionsText } from '../data/connections';
import { quietCopy, quietNote } from '../data/quiet';
import { showToast } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { BackBar, Screen } from '../ui/headers';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { KeySwitchRow } from '../ui/keyRows';
import { ListRow } from '../ui/ListRow';
import { CardNote, ErrorState, Section, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { StatusPill } from '../ui/StatusPill';
import { useBottomRoom } from '../ui/screenBottom';
import { CheckRow, ChoiceBlocks, LevelBlock, NameBlock, SignInBlock } from './connect/ConnectionChanges';
import { errorText, outcomeText, showNotice } from './feedback';
import { WhatWhombatWatches } from './thing/WhatWhombatWatches';

type Props = NativeStackScreenProps<RootStackParamList, 'Connection'>;

export function ConnectionScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const gatewayTextHere = gatewayText(rawLocale);
  const connectionsTextHere = connectionsText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  const { now, timeZone } = useViewContext();
  const { connectionId, title, back: backParam, thingId } = route.params;
  const back = backParam ?? tMobile('screens2.common.back');
  // An AI gateway's switches (AIG-05, AP-1123): a runtime with `ai.gateway`.
  const query = useConnectionTools({ params: { burrow: slug, connectionId } });
  const setGateway = useSetAiGateway(slug);
  const words = useAgentWords();
  const scroll = useRef<ScrollView>(null);
  // Sign in again asked from the level's note for a connection made with a code: its form in SIGN-IN.
  const [againAsked, setAgainAsked] = useState(0);
  // What Whombat watches (QN-15; quiet-notices-mobile.md AP-4865): the page's thing (a device's own), else the
  // connection; on a Whombat with `things.quiet`. One without a page (a mail account) has nothing to watch: no section.
  const watchThing = thingId ?? thingIdOf('connection', connectionId);
  const watch = useThingWatch(
    { params: { burrow: slug, thing: watchThing } },
    {
      retry: false,
    },
  );
  const quiet = useQuietActions(slug, watchThing, { timeZone, note: quietNote(showToast) });
  const watchGone = !!watch.error && 'status' in watch.error && watch.error.status === 404;
  const model = useMemo(
    () => (query.data ? connectionDetail(query.data, now, timeZone, slug, rawLocale) : null),
    [query.data, now, timeZone, slug, rawLocale],
  );
  // The burrow's gateway, when it is this connection (one per burrow, AIG-01).
  const burrowGateway = aiGatewayOf(bootstrap.burrow);
  const gateway = model?.gateway ?? null;
  const switchedOn = burrowGateway?.connectionId === connectionId ? burrowGateway : null;

  // Save a switch (AIG-05); switching one on for Fusebox asks first (AIG-06).
  const save = (provider: GatewayProvider, on: boolean) => {
    if (!model || setGateway.isPending) return;
    setGateway.mutate(
      { params: { burrow: slug }, body: provider === 'claude' ? { claude: on } : { codex: on } },
      {
        onSuccess: (result) => {
          const text = outcomeText(result, rawLocale);
          if (text) return Alert.alert(text.title, text.body);
          showNotice(gatewaySavedText(provider, model.title, on, rawLocale));
        },
        onError: (error) =>
          Alert.alert(tMobile('managed.that-didnt-go-through'), errorText(error, rawLocale)),
      },
    );
  };
  const change = (provider: GatewayProvider, on: boolean) => {
    if (!model || !gateway) return;
    const confirm = gatewayConfirm(burrowGateway?.kind ?? gateway.kind, provider, model.title, on, rawLocale);
    if (!confirm) return save(provider, on);
    Alert.alert(confirm.title, confirm.body, [
      { text: confirm.cancel, style: 'cancel' },
      { text: confirm.confirm, onPress: () => save(provider, true) },
    ]);
  };
  const usedBy = gatewayUsedBy(switchedOn, rawLocale);

  const conn = query.data?.connection ?? null;
  const entry = conn ? catalogEntry(conn.catalogId) : null;
  // Signing in again on the form (sign in once, an OAuth client; a key made at Look only): Connect {Name}, the address
  // filled in. A connection made with a code (T3 Code's pairing code) signs in again in SIGN-IN, never anew.
  const signInAgain = () => {
    if (!conn) return;
    if (entry && codeSignInOf(entry)) return setAgainAsked((n) => n + 1);
    navigation.navigate('Connect', {
      catalogId: conn.catalogId,
      ...(conn.fields.url ? { url: conn.fields.url } : {}),
      back: model?.title ?? back,
    });
  };
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const notFound = !!query.error && 'status' in query.error && query.error.status === 404;

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      {/* The keyboard pushes the page up, so a new password and the code DSM asks for stay in sight (AP-3958, AP-1697). */}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => {
                void query.refetch();
                void watch.refetch();
              }}
              colors={[theme.colors.ink]}
              progressBackgroundColor={theme.colors.sf}
            />
          }
        >
          <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 4 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {connectionsTextHere.title.toUpperCase()}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {model ? <ConnectionLogo logo={model.logo} /> : null}
              <Text
                size={25}
                weight={700}
                lh={1.15}
                tracking={-0.02}
                accessibilityRole="header"
                style={{ flex: 1 }}
              >
                {model?.title ?? title}
              </Text>
            </View>
            {model ? (
              <Text size={11.5} mono color={theme.colors.mut}>
                {model.meta}
              </Text>
            ) : null}
          </View>

          {!model ? (
            notFound ? (
              // A personal connection of someone else's is a plain 404, like one that was removed (CX-25).
              <ErrorState text={connectionsTextHere.notFound} />
            ) : query.error ? (
              <ErrorState text={connectionsTextHere.detailFailed} onRetry={() => void query.refetch()} />
            ) : (
              <SkeletonRows count={4} lines={2} label={connectionsTextHere.loadingDetail} />
            )
          ) : (
            <>
              <Section title={connectionsTextHere.connection}>
                <ListRow
                  title={model.detail ?? model.title}
                  titleMono={!!model.detail}
                  trailing={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {!model.gateway && !model.vaultSync ? (
                        <StatusPill text={model.access} tone="neutral" />
                      ) : null}
                      <StatusDot color={toneColor(theme, model.state.tone)} label={model.state.label} />
                    </View>
                  }
                  accessibilityLabel={[
                    `${model.detail ?? model.title}, ${model.state.label}`,
                    model.checked,
                    model.connectedBy,
                    ...(!model.gateway && !model.vaultSync ? [model.access] : []),
                    ...model.checks.map((k) => k.message),
                  ].join('. ')}
                >
                  <Text size={14} lh={1.45} color={toneColor(theme, model.state.tone)}>
                    {model.stateLabel}
                  </Text>
                  <Text size={11.5} mono color={theme.colors.mut}>
                    {model.connectedBy}
                  </Text>
                  {model.checks.map((k) => (
                    <Text key={k.id} size={13} lh={1.4} color={toneColor(theme, k.tone)}>
                      {k.message}
                    </Text>
                  ))}
                </ListRow>
                {conn && entry ? <CheckRow slug={slug} entry={entry} conn={conn} /> : null}
              </Section>

              {conn ? <NameBlock key={`name-${conn.label}`} slug={slug} conn={conn} /> : null}
              {conn && entry && !model.gateway && !model.vaultSync ? (
                <LevelBlock
                  key={`level-${conn.access}`}
                  slug={slug}
                  entry={entry}
                  conn={conn}
                  onSignInAgain={signInAgain}
                />
              ) : null}
              {conn && entry ? <ChoiceBlocks slug={slug} entry={entry} conn={conn} /> : null}

              {gateway ? (
                <Section title={gatewayTextHere.section}>
                  <ListRow title={usedBy.title} body={usedBy.text} />
                  {gatewaySwitches(model.title, rawLocale).map((sw) => (
                    <KeySwitchRow
                      key={sw.provider}
                      label={sw.label}
                      on={switchedOn?.[sw.provider] ?? false}
                      note={sw.hint}
                      onChange={!setGateway.isPending ? (next) => change(sw.provider, next) : undefined}
                    />
                  ))}
                </Section>
              ) : null}

              {!watchGone ? (
                <Section title={quietCopy(rawLocale).watchTitle.toUpperCase()}>
                  <WhatWhombatWatches
                    watch={watch.data}
                    pending={watch.isPending}
                    failed={watch.isError}
                    onRetry={() => void watch.refetch()}
                    actions={quiet}
                    timeZone={timeZone}
                    now={now.getTime()}
                    divider="bottom"
                    inset={16}
                  />
                </Section>
              ) : null}

              {model.gateway || model.vaultSync ? null : (
                <Section title={connectionsTextHere.tools}>
                  {model.tools.length === 0 ? <CardNote>{connectionsTextHere.noTools}</CardNote> : null}
                  {model.tools.map((t) => (
                    <ListRow
                      key={t.name}
                      title={t.name}
                      titleMono
                      meta={t.access}
                      trailing={
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          {t.isNew ? <StatusPill text={t.isNew} tone="warn" /> : null}
                          <StatusPill text={t.tierLabel} tone={t.tierTone} />
                        </View>
                      }
                      body={t.description}
                      accessibilityLabel={t.accessibilityLabel}
                    >
                      {t.alwaysAsks ? (
                        <Text size={11.5} mono color={theme.colors.warn}>
                          {t.alwaysAsks}
                        </Text>
                      ) : null}
                    </ListRow>
                  ))}
                  {model.truncated ? <CardNote>{model.truncated}</CardNote> : null}
                </Section>
              )}

              {model.guide ? (
                <Section title={connectionsTextHere.guide(words.Name)}>
                  <CardNote>{model.guide}</CardNote>
                </Section>
              ) : null}

              {conn && entry ? (
                <SignInBlock
                  slug={slug}
                  entry={entry}
                  conn={conn}
                  onRemoved={() => navigation.navigate('Connections')}
                  againAsked={againAsked}
                  onAgainShown={() => scroll.current?.scrollToEnd({ animated: true })}
                />
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
