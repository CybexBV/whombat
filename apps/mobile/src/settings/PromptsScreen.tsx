/**
 * Settings → You → Prompts on the phone (Whombat docs/decisions/prompts.md; app prompts-phone.md), beside Shared links
 * and drawn as it is: what prompts are, then every prompt (its title, its first line, where it last ran: “Ran 3 days
 * ago · Fusebox”), each opening its editor; New prompt; and, while one of Whombat's is gone or changed, “Bring back
 * Whombat’s prompts” with what it does, asked first. Pulling down reads the list again. A Whombat from before prompts
 * says it needs an update (You shows no row to here then; a link still can). Bringing them back changes the list in
 * place, with a light tap.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { PROMPT_WORDS } from '@whombat/client';
import { useMemo } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { councilActionProblem } from '../data/council';
import { canRestorePrompts, promptListLine } from '../data/prompts';
import { usePrompts, usePromptWrites } from '../data/usePrompts';
import { Card, LinkRow, Note, Row } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { showFailure } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { haptic } from '../ui/haptics';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';

type Props = NativeStackScreenProps<RootStackParamList, 'SettingsPrompts'>;

export function PromptsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { clock, slug } = useBurrowBase();
  const bottomRoom = useBottomRoom();
  const here = usePrompts();
  const { restore } = usePromptWrites();
  const now = clock();
  const day = now.toDateString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lines change with the day (“Ran today”), read from the clock then
  const lines = useMemo(() => here.prompts?.map((p) => promptListLine(p, now)) ?? null, [here.prompts, day]);
  const back = <BackBar label="Back" onPress={() => navigation.goBack()} />;
  if (!here.prompts)
    return (
      <Screen>
        {back}
        {here.error ? (
          <ErrorState
            text={councilActionProblem(here.error)}
            {...(here.older ? {} : { onRetry: here.refetch })}
          />
        ) : (
          <Loading />
        )}
      </Screen>
    );
  const onRestore = () =>
    Alert.alert(PROMPT_WORDS.restore, PROMPT_WORDS.restoreHint, [
      { text: PROMPT_WORDS.cancel, style: 'cancel' },
      {
        text: PROMPT_WORDS.restore,
        onPress: () =>
          restore.mutate(
            { params: { burrow: slug }, body: {} },
            {
              onSuccess: (r) => (r.status === 'ok' ? haptic('success') : showFailure(PROMPT_WORDS.failed)),
              onError: (e) => showFailure(councilActionProblem(e)),
            },
          ),
      },
    ]);
  return (
    <Screen>
      {back}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
        refreshControl={<RefreshControl refreshing={here.refreshing} onRefresh={here.refetch} />}
      >
        <LargeTitle title={PROMPT_WORDS.title} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          <Note text={PROMPT_WORDS.intro} />
          <Card>
            {!lines?.length ? (
              <Row first title={PROMPT_WORDS.empty} />
            ) : (
              lines.map((l, i) => (
                <LinkRow
                  key={l.id}
                  first={i === 0}
                  title={l.title}
                  body={l.preview}
                  meta={l.ran}
                  label={l.label}
                  onPress={() => navigation.navigate('PromptEdit', { promptId: l.id })}
                />
              ))
            )}
          </Card>
          <Button
            label={PROMPT_WORDS.add}
            variant="secondary"
            onPress={() => navigation.navigate('PromptEdit', {})}
          />
          {canRestorePrompts(here.prompts) ? (
            <View style={{ gap: 6, paddingTop: 4 }}>
              <Button
                label={PROMPT_WORDS.restore}
                variant="quiet"
                busy={restore.isPending}
                accessibilityHint={PROMPT_WORDS.restoreHint}
                onPress={onRestore}
              />
              <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
                {PROMPT_WORDS.restoreHint}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
