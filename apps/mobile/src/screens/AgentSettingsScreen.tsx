/**
 * Settings → the assistant by its name (Whombat one-agent.md OA-09; one-agent.md AP-4965; the web's `?tab=agent`): its
 * page. Under “‹ Settings”, its face and name, then its parts as tabs that scroll sideways — Name and face, AI sign-in,
 * Memory (what it remembers about you and the notes it reads in every chat), What it may do (every permission on one
 * page), Looks ahead (what it checks on your calendar, on a Whombat that has it) and Council (who sits on the councils
 * it asks) — and the open part under them, with its own pull to refresh.
 * `whombat://settings/agent` opens it, `?part=may` at a part; an old part opens where it went (Notes in Memory, the
 * model, keys, what runs, schedules, spend and skills in Advanced). You change all of it (one-person-android.md
 * AP-5761). Leaving a part (or the page) with unsaved changes asks first. A failed load says what happened (AP-707).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { agentFaceOf, hasLooksAhead } from '@whombat/client';
import { useAgent, useSessionProtocol } from '@whombat/client/react';
import { agentStatusCopy } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WhombatAvatar } from '../avatars/Avatars';
import { agentLoadProblem, contractMismatchLine } from '../data/agentLoad';
import { type AgentPart, agentKeyParam, agentPageText, agentParts } from '../data/agentPage';
import { useBurrow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { NeedsNewerApp } from '../managed/NeedsNewerApp';
import type { RootStackParamList } from '../navigation/routes';
import { agentPartTarget } from '../settings/groups';
import { settingsText } from '../settings/list';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { ErrorState, Skeleton, SkeletonRows } from '../ui/primitives';
import { UnderlineTabs } from '../ui/UnderlineTabs';
import { AiPart } from './agent/AiPart';
import { CouncilPart } from './agent/CouncilPart';
import { LooksAheadPart } from './agent/LooksAheadPart';
import { MayPart } from './agent/MayPart';
import { MemoryPart } from './agent/MemoryPart';
import { NameAndFacePart } from './agent/NameAndFacePart';
import { type PartProps, useUnsavedGuard } from './agent/parts';

type Props = NativeStackScreenProps<RootStackParamList, 'SettingsAgent'>;

export function AgentSettingsScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const settingsTextHere = settingsText(rawLocale);

  const agentStatusCopyHere = agentStatusCopy(rawLocale);
  const agentPageTextHere = agentPageText(rawLocale);

  const theme = useTheme();
  const { slug, mode } = useBurrow();
  const words = useAgentWords();
  const query = useAgent({ params: { burrow: slug } }, { retry: false });
  const profile = query.data;
  const asked = route.params?.part;
  const target = agentPartTarget(asked, { mode }, agentKeyParam(route.params?.key));
  const [chosen, setPart] = useState<AgentPart>(() => (target.kind === 'part' ? target.part : 'profile'));
  // A link that names another part (What it may do from a card) opens it.
  const askedPart = asked && target.kind === 'part' ? target.part : null;
  useEffect(() => {
    if (askedPart) setPart(askedPart);
  }, [askedPart]);
  // An old part opens where it went (Advanced's model, keys, …; Spend; Skills), in this page's place.
  const moved = useRef(false);
  const elsewhere = target.kind === 'elsewhere' ? target.route : null;
  useEffect(() => {
    if (!elsewhere || moved.current) return;
    moved.current = true;
    (navigation.replace as (name: string, params?: object) => void)(elsewhere.name, elsewhere.params);
  }, [elsewhere, navigation]);

  const name = profile?.agent.name ?? words.name;
  const parts = agentParts(name, { looksAhead: hasLooksAhead(useSessionProtocol()) }, rawLocale);
  // A part this Whombat doesn't have (Looks ahead on an older one) opens Name and face.
  const part: AgentPart = parts.some((p) => p.key === chosen) ? chosen : 'profile';
  const partLabel = parts.find((p) => p.key === part)?.label ?? '';
  // Unsaved changes in the open part: leaving the page, or the part, asks first.
  const guard = useUnsavedGuard(name, partLabel);
  const open = (next: AgentPart) => {
    if (next !== part) guard.confirm(() => setPart(next));
  };

  // What didn't match, in the log (`adb logcat`), paths and messages only (AP-707).
  useEffect(() => {
    const line = contractMismatchLine(query.error);
    if (line) console.warn(`Settings → ${name}: the Whombat's answer doesn't match this app. ${line}`);
  }, [query.error, name]);
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Settings' });

  if (!profile) {
    const problem = query.error ? agentLoadProblem(query.error, rawLocale) : null;
    return (
      <Screen>
        <BackBar label={settingsTextHere.title} onPress={goBack} />
        {problem?.kind === 'newer' ? (
          <NeedsNewerApp />
        ) : problem?.kind === 'gone' ? (
          <ErrorState text={problem.text} />
        ) : problem ? (
          <ErrorState text={problem.text} onRetry={() => void query.refetch()} />
        ) : (
          <View style={{ paddingTop: 10 }} accessibilityLabel={agentPageTextHere.loading(words.name)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22 }}>
              <Skeleton width={56} height={56} radius={28} />
              <Skeleton width={140} height={20} />
            </View>
            <SkeletonRows count={4} lines={1} />
          </View>
        )}
      </Screen>
    );
  }

  const agent = profile.agent;
  const props: PartProps = {
    profile,
    refetch: () => void query.refetch(),
    onDirtyChange: guard.onDirtyChange,
  };
  return (
    <Screen>
      <BackBar label={settingsTextHere.title} onPress={goBack} />
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingTop: 2 }}
      >
        <WhombatAvatar face={agentFaceOf(agent)} size={56} crop="bust" label={agent.name} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            size={25}
            weight={700}
            lh={1.15}
            tracking={-0.02}
            accessibilityRole="header"
            numberOfLines={1}
          >
            {agent.name}
          </Text>
          <Text size={11} weight={500} mono tracking={0.05} color={theme.status[agent.status]}>
            {agentStatusCopyHere[agent.status].label.toUpperCase()}
          </Text>
        </View>
      </View>
      <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
        <UnderlineTabs<AgentPart>
          tabs={parts}
          value={part}
          onChange={open}
          label={agentPageTextHere.parts(agent.name)}
          bleed={16}
        />
      </View>
      <View style={{ flex: 1 }} key={part}>
        <PartPanel part={part} props={props} />
      </View>
    </Screen>
  );
}

function PartPanel({ part, props }: { part: AgentPart; props: PartProps }) {
  switch (part) {
    case 'ai':
      return <AiPart />;
    case 'memory':
      return <MemoryPart {...props} />;
    case 'may':
      return <MayPart {...props} />;
    case 'ahead':
      return <LooksAheadPart {...props} />;
    case 'council':
      return <CouncilPart {...props} />;
    default:
      return <NameAndFacePart {...props} />;
  }
}
