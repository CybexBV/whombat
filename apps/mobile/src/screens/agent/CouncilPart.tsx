/**
 * Settings → the assistant → **Council** (Whombat docs/decisions/council.md; app council-phone.md): what a council is,
 * then the one council — who T3 Code's council sits, a line per seat to read (a seat T3 Code can't run now muted, with
 * why), where to change who sits (the skill in T3 Code), and its summary — opening it to change its rounds and score,
 * and, when the person chose theirs, a quiet “Use the usual rounds and score” that asks first. While T3 Code isn't
 * connected or can't be reached, why, and the council to read only. Pulling down reads it again. An older Whombat
 * (`unknown_op`) says it needs an update.
 */
import { useQueryClient } from '@tanstack/react-query';
import { councilSetupWords } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import { api } from '@whombat/core';
import { useMemo } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { councilActionProblem, olderWhombat } from '../../data/council';
import { type CouncilSeatLine, type CouncilShown, councilPartView } from '../../data/councilSetups';
import { useI18n } from '../../i18n';
import { useAppNavigation } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { haptic } from '../../ui/haptics';
import { RowChevron } from '../../ui/ListRow';
import { ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';
import { outcomeText, showFailure, showNotice } from '../feedback';
import { Note, type PartProps, PartScroll } from './parts';

/** `councils.setup`: who T3 Code's council sits, the person's rounds and score, and what T3 Code can run now. */
export const useCouncilSetup = queryHook(api.councils.setup);

export function CouncilPart({ profile }: PartProps) {
  const { rawLocale } = useI18n();
  const councilSetupWordsHere = councilSetupWords(rawLocale);
  const theme = useTheme();
  const navigation = useAppNavigation();
  const qc = useQueryClient();
  const { slug } = useBurrowBase();
  const name = profile.agent.name;
  const query = useCouncilSetup({ params: { burrow: slug } }, { retry: false });
  const view = useMemo(
    () => (query.data ? councilPartView(query.data, name, rawLocale) : null),
    [query.data, name, rawLocale],
  );
  const reset = useApiMutation(api.councils.resetSetup);
  const open = () => navigation.navigate('SettingsCouncil');

  const onReset = () =>
    Alert.alert(councilSetupWordsHere.resetAsk, councilSetupWordsHere.resetBody, [
      { text: councilSetupWordsHere.cancel, style: 'cancel' },
      {
        text: councilSetupWordsHere.reset,
        style: 'destructive',
        onPress: () =>
          reset.mutate(
            { params: { burrow: slug }, body: {} },
            {
              onSuccess: (result) => {
                const text = outcomeText(result, rawLocale);
                if (text) return Alert.alert(text.title, text.body);
                haptic('success');
                showNotice(councilSetupWordsHere.wasReset);
                void qc.invalidateQueries({ queryKey: queryKeys.scope('councils.setup', { burrow: slug }) });
              },
              onError: (error) => showFailure(councilActionProblem(error, rawLocale), rawLocale),
            },
          ),
      },
    ]);

  return (
    <PartScroll refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {councilSetupWordsHere.intro(name)}
        </Text>
      </View>
      {!view ? (
        query.error ? (
          olderWhombat(query.error) ? (
            <Section>
              <Note>{councilActionProblem(query.error, rawLocale)}</Note>
            </Section>
          ) : (
            <ErrorState
              text={councilActionProblem(query.error, rawLocale)}
              onRetry={() => void query.refetch()}
            />
          )
        ) : (
          <SkeletonRows count={1} lines={4} label={councilSetupWordsHere.title} />
        )
      ) : (
        <>
          {view.t3 ? (
            <Section>
              <Note>{view.t3}</Note>
            </Section>
          ) : null}
          <Section>
            <CouncilView council={view.council} onOpen={view.editable ? open : null} />
          </Section>
          {view.canReset ? (
            <Section>
              <Touchable
                onPress={onReset}
                disabled={reset.isPending}
                feedback="wash"
                accessibilityLabel={councilSetupWordsHere.reset}
                style={{ minHeight: 52, justifyContent: 'center', paddingHorizontal: 16 }}
              >
                <Text size={15.5} weight={500} color={theme.colors.ink2}>
                  {councilSetupWordsHere.reset}
                </Text>
              </Touchable>
            </Section>
          ) : null}
        </>
      )}
    </PartScroll>
  );
}

/** The council: who T3 Code's council sits, where to change that, its summary; a tap opens its rounds and score. */
function CouncilView({ council, onOpen }: { council: CouncilShown; onOpen: (() => void) | null }) {
  const { rawLocale } = useI18n();
  const councilSetupWordsHere = councilSetupWords(rawLocale);
  const theme = useTheme();
  const content = (
    <>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
        <Text size={14.5} lh={1.45} color={theme.colors.ink2}>
          {council.text}
        </Text>
        {council.seats.length ? <Seats seats={council.seats} /> : null}
        {council.note ? (
          <Text size={12.5} lh={1.4} color={theme.colors.mut}>
            {council.note}
          </Text>
        ) : null}
        {council.hint ? (
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {council.hint}
          </Text>
        ) : null}
        {council.summary ? (
          <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
            {council.summary}
          </Text>
        ) : null}
      </View>
      {onOpen ? <RowChevron /> : null}
    </>
  );
  const style = {
    flexDirection: 'row' as const,
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 44,
  };
  return onOpen ? (
    <Touchable
      onPress={onOpen}
      feedback="wash"
      accessibilityLabel={council.label}
      accessibilityHint={councilSetupWordsHere.edit}
      style={style}
    >
      {content}
    </Touchable>
  ) : (
    <View accessible accessibilityLabel={council.label} style={style}>
      {content}
    </View>
  );
}

/** The seats, one line each: the model and its thinking, the company after it; muted when it can't run now. */
function Seats({ seats }: { seats: readonly CouncilSeatLine[] }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {seats.map((seat) => (
        // The company goes under the model rather than cut its thinking short.
        <View
          key={seat.key}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 8,
            rowGap: 2,
            opacity: seat.available ? 1 : 0.5,
          }}
        >
          <Text size={14} color={theme.colors.ink} numberOfLines={1} style={{ flexShrink: 1 }}>
            {seat.line}
          </Text>
          <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
            {seat.provider}
          </Text>
        </View>
      ))}
    </View>
  );
}
