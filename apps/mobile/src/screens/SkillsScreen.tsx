/**
 * The agent's skills on the phone (Settings → Skills; Whombat all-skills.md SK-18, hermes-engine.md HE-41,
 * hermes-skills.md HSK-12, HSK-13; all-skills.md AP-2362, hermes-engine-app.md AP-5274, hermes-skills.md AP-5572): its
 * skill library as the web draws it (`skillLibraryView`, shared): “Skills · 42”, one line of help, a search field (name
 * and description, as you type), then one list (one-person-android.md AP-5765) — Hermes's categories by their titles,
 * then “Added by you” and “Learned by Dusty”; Off and Removed folded at the end, open while a search narrows the list.
 * Each row has its name (mono), one line of what it does, then where it came from when it isn't one of Hermes's own
 * (“Added from GitHub”) beside its status words in their tone, and a 44dp switch. A row opens the skill (`SkillScreen`)
 * by its name. No editor and no Add skills: those are the web's (AP-5574). Opened from Settings' Skills row, back to
 * Settings.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  SKILL_LIBRARY_TEXT,
  type SkillFold,
  type SkillFoldId,
  type SkillGroup,
  type SkillLibraryItem,
  type SkillRow,
  skillLibraryEndpoints,
  skillLibraryView,
} from '@whombat/client/skill-library';
import { useSkillLibrary, useSkillLibraryWrite } from '@whombat/client/skill-library/react';
import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { SKILLS_PHONE_TEXT, skillRowLabel } from '../data/skillLibrary';
import { useSkillLibraryAgent, useSkillsAbsentText } from '../data/useSkillLibraryHere';
import { useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { BackBar, Screen } from '../ui/headers';
import { ChevronDown, ChevronRight, Search, X } from '../ui/icons';
import { CardNote, ErrorState, QuietText, Section, SkeletonRows, toneColor } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';
import { useDecisionFeedback } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Skills'>;

type Block = { kind: 'group'; group: SkillGroup } | { kind: 'folds'; folds: SkillFold[] };

export function SkillsScreen({ navigation }: Props) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug } = useBurrowBase();
  const ctx = useViewContext();
  const agent = useSkillLibraryAgent();
  const absent = useSkillsAbsentText();
  const feedback = useDecisionFeedback();
  const query = useSkillLibrary(agent ? { params: { burrow: slug } } : null);
  const toggle = useSkillLibraryWrite(skillLibraryEndpoints.switch, slug);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<ReadonlySet<SkillFoldId>>(new Set());
  // Typing stays smooth on a long library: the list follows the field a moment later.
  const search = useDeferredValue(q);
  const name = query.data?.agentName ?? agent?.name ?? '';
  const view = useMemo(
    () =>
      query.data
        ? skillLibraryView(query.data, { query: search, now: ctx.now, timeZone: ctx.timeZone })
        : null,
    [query.data, search, ctx.now, ctx.timeZone],
  );
  // The groups, then the folds.
  const blocks = useMemo<Block[]>(
    () =>
      view && !view.nothingMatches
        ? [
            ...view.groups.map((group) => ({ kind: 'group' as const, group })),
            ...(view.folds.length ? [{ kind: 'folds' as const, folds: view.folds }] : []),
          ]
        : [],
    [view],
  );
  const goBack = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'Settings' });

  const onOpen = useCallback(
    (item: SkillLibraryItem) => navigation.navigate('Skill', { name: item.name }),
    [navigation],
  );
  const onSwitch = useCallback(
    (item: SkillLibraryItem, on: boolean) => {
      if (!agent) return;
      toggle.mutate(
        { params: { burrow: slug }, body: { name: item.name, on } },
        { onSuccess: feedback.onResult, onError: feedback.onError },
      );
    },
    [agent, slug, toggle.mutate, feedback],
  );
  const flip = useCallback(
    (id: SkillFoldId) =>
      setOpen((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  if (!agent)
    return (
      <Screen>
        <BackBar label={tMobile('managed.back')} onPress={goBack} />
        <QuietText>{absent}</QuietText>
      </Screen>
    );

  const header = (
    <View>
      <View style={{ paddingHorizontal: 22, paddingBottom: 12, gap: 4 }}>
        <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
          {view?.title ?? SKILLS_PHONE_TEXT.title}
        </Text>
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {SKILL_LIBRARY_TEXT.help(name)}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 12,
            paddingRight: 4,
            minHeight: 44,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
          }}
        >
          <Search size={16} color={theme.colors.mut} strokeWidth={1.75} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={SKILL_LIBRARY_TEXT.search}
            placeholderTextColor={theme.colors.mut}
            accessibilityLabel={SKILL_LIBRARY_TEXT.search}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            cursorColor={theme.colors.ink}
            selectionColor={theme.colors.brand}
            style={{
              flex: 1,
              minHeight: 44,
              color: theme.colors.ink,
              ...textMetrics({ size: 15 }),
              includeFontPadding: false,
            }}
          />
          {q ? (
            <Touchable
              onPress={() => setQ('')}
              accessibilityLabel={tMobile('screens.clear-search')}
              ringRadius={16}
              hitSlop={hitSlopFor(34)}
              style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={16} color={theme.colors.mut} strokeWidth={2} />
            </Touchable>
          ) : null}
        </View>
      </View>
      <View style={{ height: 14 }} />
    </View>
  );

  const empty =
    query.error && !query.data ? (
      <ErrorState text={SKILLS_PHONE_TEXT.failed} onRetry={() => void query.refetch()} />
    ) : !view ? (
      <SkeletonRows count={6} lines={2} label={SKILLS_PHONE_TEXT.loading} />
    ) : view.nothingMatches ? (
      search.trim() ? (
        <Section>
          <CardNote>{SKILL_LIBRARY_TEXT.noMatch(search.trim())}</CardNote>
        </Section>
      ) : (
        <QuietText>{view.empty ?? SKILL_LIBRARY_TEXT.empty(name)}</QuietText>
      )
    ) : null;

  return (
    <Screen>
      <BackBar label={tMobile('managed.back')} onPress={goBack} />
      <FlatList
        style={{ flex: 1 }}
        data={blocks}
        keyExtractor={(b) => (b.kind === 'group' ? `g:${b.group.id}` : 'folds')}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        initialNumToRender={4}
        windowSize={7}
        contentContainerStyle={{ paddingBottom: 28 + insets.bottom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
        renderItem={({ item: block }) =>
          block.kind === 'group' ? (
            <Section title={block.group.label.toUpperCase()}>
              {block.group.rows.map((row, i) => (
                <SkillRowView
                  key={row.key}
                  row={row}
                  last={i === block.group.rows.length - 1}
                  agent={name}
                  onOpen={onOpen}
                  onSwitch={onSwitch}
                />
              ))}
            </Section>
          ) : (
            <Section>
              {block.folds.map((fold, f) => {
                const shown = !!view?.filtering || open.has(fold.id);
                const lastFold = f === block.folds.length - 1;
                return (
                  <View key={fold.id}>
                    <FoldRow
                      fold={fold}
                      open={shown}
                      last={lastFold && !shown}
                      onPress={() => flip(fold.id)}
                    />
                    {shown
                      ? fold.rows.map((row, i) => (
                          <SkillRowView
                            key={row.key}
                            row={row}
                            last={lastFold && i === fold.rows.length - 1}
                            agent={name}
                            onOpen={onOpen}
                            onSwitch={onSwitch}
                          />
                        ))
                      : null}
                  </View>
                );
              })}
            </Section>
          )
        }
      />
    </Screen>
  );
}

/**
 * A skill's row: its name (mono), one line of what it does, and where it came from (when it isn't one of Hermes's own)
 * beside its status words in their tone, opening the skill; the switch beside it as its own TalkBack stop.
 */
const SkillRowView = memo(
  function SkillRowView({
    row,
    last,
    agent,
    onOpen,
    onSwitch,
  }: {
    row: SkillRow;
    /** The card's last row: no hairline under it (the card's edge is there). */
    last: boolean;
    agent: string;
    onOpen: (item: SkillLibraryItem) => void;
    onSwitch: (item: SkillLibraryItem, on: boolean) => void;
  }) {
    const theme = useTheme();
    const { item } = row;
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingRight: 12,
          borderBottomWidth: last ? 0 : 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <Touchable
          onPress={() => onOpen(item)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={skillRowLabel(row)}
          accessibilityHint={SKILLS_PHONE_TEXT.opens}
          style={{ flex: 1, minWidth: 0, minHeight: 44, gap: 3, paddingVertical: 12, paddingLeft: 16 }}
        >
          <Text size={14.5} weight={500} mono numberOfLines={1}>
            {item.name}
          </Text>
          {item.description ? (
            <Text size={13.5} lh={1.35} color={theme.colors.ink2} numberOfLines={1}>
              {item.description}
            </Text>
          ) : null}
          <Text size={11.5} mono numberOfLines={1} color={theme.colors.mut}>
            {row.origin ? `${row.origin} · ` : ''}
            <Text size={11.5} mono color={toneColor(theme, row.tone === 'mut' ? null : row.tone)}>
              {row.status}
            </Text>
          </Text>
        </Touchable>
        {row.canSwitch ? (
          <Switch
            value={row.on}
            onValueChange={(v) => onSwitch(item, v)}
            accessibilityLabel={item.name}
            accessibilityHint={SKILLS_PHONE_TEXT.switchHint(item.name, agent, row.on)}
            accessibilityRole="switch"
            {...switchColors(theme, row.on)}
            style={{ minHeight: 44 }}
          />
        ) : (
          <ChevronRight size={16} color={theme.colors.mut} strokeWidth={2} />
        )}
      </View>
    );
  },
  (a, b) =>
    a.row.item === b.row.item &&
    a.row.status === b.row.status &&
    a.row.origin === b.row.origin &&
    a.row.tone === b.row.tone &&
    a.row.on === b.row.on &&
    a.row.canSwitch === b.row.canSwitch &&
    a.last === b.last &&
    a.agent === b.agent &&
    a.onOpen === b.onOpen &&
    a.onSwitch === b.onSwitch,
);

/** A fold's header row: chevron and “Off · 3”; 48dp, the whole row a button. */
function FoldRow({
  fold,
  open,
  last,
  onPress,
}: {
  fold: SkillFold;
  open: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={fold.label}
      accessibilityHint={SKILLS_PHONE_TEXT.foldHint(open)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 48,
        paddingHorizontal: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <Chevron size={16} color={theme.colors.mut} strokeWidth={2} />
      <Text size={15} weight={500}>
        {fold.label}
      </Text>
    </Touchable>
  );
}
