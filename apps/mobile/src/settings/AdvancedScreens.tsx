/**
 * Settings → Advanced on the phone (the web's `?tab=advanced`): the expert pages, away from the rest. The list, in the
 * shared folds — the assistant's AI, its work, this Whombat — one line each (`advancedRowsOnPhone`), every row opening
 * its page: Model and effort, AI on this Whombat and Running are drawn here (`SettingsAdvancedPart`); Spend, Skills, the
 * audit log and a Whombat's diagnostics (its About) open the screens the phone had. Nothing here needs changing for
 * Whombat to work. The keys are drawn here too, as a page under What it may do (its “Change them”).
 */
import { type RouteProp, StackActions, useRoute } from '@react-navigation/native';
import { type AdvancedSection, advancedRows, agentKeysText, SETTINGS_GROUP_TEXT } from '@whombat/client';
import { useAgent, useHostInfo } from '@whombat/client/react';
import { useEffect } from 'react';
import { View } from 'react-native';
import { agentLoadProblem } from '../data/agentLoad';
import { agentKeyParam } from '../data/agentPage';
import { useBurrow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { NeedsNewerApp } from '../managed/NeedsNewerApp';
import { type AppNavigation, useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { KeysPart } from '../screens/agent/KeysPart';
import { ModelPart } from '../screens/agent/ModelPart';
import { type PartProps, useUnsavedGuard } from '../screens/agent/parts';
import { ServicesPart } from '../screens/agent/ServicesPart';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { ListRow } from '../ui/ListRow';
import { ErrorState, SectionLabel, SkeletonRows } from '../ui/primitives';
import { AiOnThisWhombat } from './AiSection';
import { type AdvancedPagePart, type AdvancedRoute, advancedRowsOnPhone, isAdvancedPagePart } from './groups';
import { SettingsPage } from './SettingsPages';

const SECTIONS: readonly AdvancedSection[] = ['ai', 'work', 'whombat'];

function go(navigation: AppNavigation, route: AdvancedRoute) {
  // The union pairs each name with its params; TypeScript cannot pair them itself.
  (navigation.navigate as (name: string, params?: object) => void)(route.name, route.params);
}

export function SettingsAdvancedScreen() {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug, mode } = useBurrow();
  const words = useAgentWords();
  // Running says what runs, or why nothing can, once the host answers; a host that can't be asked has none.
  const host = useHostInfo({ params: { burrow: slug } }, { retry: false });
  const services = host.data ? true : host.error ? false : undefined;
  const rows = advancedRowsOnPhone(words.name, { mode, ...(services === undefined ? {} : { services }) });
  const labels = SETTINGS_GROUP_TEXT.advanced.sections(words.name);
  return (
    <SettingsPage title={SETTINGS_GROUP_TEXT.groups(words.name).advanced}>
      <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {SETTINGS_GROUP_TEXT.advanced.intro}
      </Text>
      {SECTIONS.map((section) => {
        const mine = rows.filter((r) => r.section === section);
        if (mine.length === 0) return null;
        return (
          <View key={section}>
            <SectionLabel>{labels[section]}</SectionLabel>
            <View
              style={{
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
                overflow: 'hidden',
              }}
            >
              {mine.map((row) => (
                <ListRow
                  key={row.key}
                  title={row.title}
                  body={row.line}
                  trailing="›"
                  onPress={() => go(navigation, row.route)}
                  accessibilityLabel={row.label}
                />
              ))}
            </View>
          </View>
        );
      })}
    </SettingsPage>
  );
}

/**
 * One of Advanced's own pages (`part`): the AI on this Whombat, or a part of the assistant's profile — Model and effort,
 * Running — under “‹ Advanced”, its title and line; or Keys and allowed commands (at `key`), under “‹ What {assistant}
 * may do”, where it is opened from. Leaving Keys with unsaved changes asks first. A part the phone doesn't have opens
 * Advanced's list instead.
 */
export function SettingsAdvancedPartScreen() {
  const navigation = useAppNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsAdvancedPart'>>();
  const words = useAgentWords();
  const part = isAdvancedPagePart(route.params?.part) ? route.params.part : null;
  const row =
    part === 'keys'
      ? agentKeysText(words.name)
      : part
        ? advancedRows(words.name).find((r) => r.key === part)
        : undefined;
  useEffect(() => {
    if (!part) navigation.dispatch(StackActions.replace('SettingsAdvanced'));
  }, [part, navigation]);
  if (!part || !row) return <Screen>{null}</Screen>;
  if (part === 'ai')
    return (
      <SettingsPage title={row.title} back={SETTINGS_GROUP_TEXT.advanced.back}>
        <PartLine line={row.line} />
        <AiOnThisWhombat />
      </SettingsPage>
    );
  return (
    <ProfilePartPage
      part={part}
      title={row.title}
      line={row.line}
      showKey={agentKeyParam(route.params?.key)}
    />
  );
}

function PartLine({ line }: { line: string }) {
  const theme = useTheme();
  return (
    <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6, marginTop: -10 }}>
      {line}
    </Text>
  );
}

/** A page that works on the assistant's profile: it waits for the profile, then shows the part with its save guard. */
function ProfilePartPage({
  part,
  title,
  line,
  showKey,
}: {
  part: Exclude<AdvancedPagePart, 'ai'>;
  title: string;
  line: string;
  showKey: string | undefined;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug } = useBurrow();
  const words = useAgentWords();
  const query = useAgent({ params: { burrow: slug } }, { retry: false });
  const profile = query.data;
  const guard = useUnsavedGuard(profile?.agent.name ?? words.name, title);
  // The keys are a page under What it may do; the rest are Advanced's.
  const back =
    part === 'keys' ? SETTINGS_GROUP_TEXT.agent(words.name).may : SETTINGS_GROUP_TEXT.advanced.back;
  const goBack = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : part === 'keys'
        ? navigation.navigate('SettingsAgent', { part: 'may' })
        : navigation.navigate('SettingsAdvanced');
  const problem = !profile && query.error ? agentLoadProblem(query.error) : null;
  const props: PartProps | null = profile
    ? { profile, refetch: () => void query.refetch(), onDirtyChange: guard.onDirtyChange }
    : null;
  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <View style={{ paddingHorizontal: 22, paddingTop: 2, gap: 4 }}>
        <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
          {title}
        </Text>
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {line}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        {props ? (
          part === 'model' ? (
            <ModelPart {...props} />
          ) : part === 'keys' ? (
            <KeysPart {...props} showKey={showKey} />
          ) : (
            <ServicesPart {...props} />
          )
        ) : problem?.kind === 'newer' ? (
          <NeedsNewerApp />
        ) : problem?.kind === 'gone' ? (
          <ErrorState text={problem.text} />
        ) : problem ? (
          <ErrorState text={problem.text} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows count={3} lines={1} label={title} />
        )}
      </View>
    </Screen>
  );
}
