/**
 * One skill on the phone (Whombat all-skills.md SK-18, hermes-engine.md HE-41, hermes-skills.md HSK-10…HSK-13;
 * all-skills.md AP-2363, hermes-engine-app.md AP-5275, hermes-skills.md AP-5573): the shared panel (`skillPanel`) as the
 * web's — its tag (“Productivity · Added from Hermes”, “Note taking · Changed”, “Learned by Neo”), the name (mono),
 * what it does, the lines (what it needs, that a newer version is there, when it was learned, changed or added),
 * “Hermes’s version changed” — then “Neo uses it” with its switch, **Restore Hermes’s** and **Remove** (asked first: a
 * built-in stays removed until restored, a hub skill goes for good, a learned one is forgotten), the SKILL.md rendered
 * without its front matter, and its files by name and size. A skill is its name (one list, one-person-android.md
 * AP-5765). Editing, Compare, Update and Add skills are the web's (AP-5574).
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApiError } from '@whombat/client';
import {
  fileBytes,
  skillLibraryEndpoints,
  skillLibraryText,
  skillPanel,
} from '@whombat/client/skill-library';
import {
  useSkillLibrary,
  useSkillLibrarySkill,
  useSkillLibraryWrite,
} from '@whombat/client/skill-library/react';
import { useMemo } from 'react';
import { Alert, RefreshControl, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { removeConfirm, restoreConfirm, type SkillConfirm, skillsPhoneText } from '../data/skillLibrary';
import { useSkillLibraryAgent, useSkillsAbsentText } from '../data/useSkillLibraryHere';
import { useI18n } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { ListRow } from '../ui/ListRow';
import { Button, ErrorState, QuietText, Section, SkeletonRows } from '../ui/primitives';
import { RichText } from '../ui/rich';
import { switchColors } from '../ui/switchColors';
import { errorText, outcomeText, showNotice, useDecisionFeedback } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Skill'>;

/** Ask first, then run `go` (Cancel does nothing). */
function ask(confirm: SkillConfirm, cancel: string, go: () => void) {
  Alert.alert(confirm.title, confirm.body ?? undefined, [
    { text: cancel, style: 'cancel' },
    { text: confirm.action, style: confirm.destructive ? 'destructive' : 'default', onPress: go },
  ]);
}

export function SkillScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const skillLibraryTextHere = skillLibraryText(rawLocale);
  const phone = skillsPhoneText(rawLocale);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug } = useBurrowBase();
  const ctx = useViewContext();
  const agent = useSkillLibraryAgent();
  const absent = useSkillsAbsentText();
  const feedback = useDecisionFeedback();
  const { name } = route.params;
  const params = { burrow: slug };
  const library = useSkillLibrary(agent ? { params } : null);
  const query = useSkillLibrarySkill(agent ? { params, query: { name } } : null);
  const toggle = useSkillLibraryWrite(skillLibraryEndpoints.switch, slug);
  const restore = useSkillLibraryWrite(skillLibraryEndpoints.restore, slug);
  const remove = useSkillLibraryWrite(skillLibraryEndpoints.remove, slug);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Skills'));
  // The library's row follows a switch at once (the write updates it before the answer); the skill's own read catches
  // up after.
  const detail = useMemo(() => {
    if (!query.data) return null;
    const item = library.data?.items.find((i) => i.name === name) ?? query.data.item;
    return { ...query.data, item };
  }, [query.data, library.data, name]);
  const categories = library.data?.categories;
  const words = library.data?.agentName ?? agent?.name ?? '';
  const panel = useMemo(
    () =>
      detail
        ? skillPanel(detail, {
            now: ctx.now,
            timeZone: ctx.timeZone,
            categories,
            agent: words,
            locale: rawLocale,
          })
        : null,
    [detail, ctx.now, ctx.timeZone, categories, words, rawLocale],
  );

  if (!detail || !panel) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Screen>
        <BackBar label={phone.title} onPress={goBack} />
        {!agent ? (
          <QuietText>{absent}</QuietText>
        ) : gone ? (
          <QuietText>{phone.gone}</QuietText>
        ) : query.error ? (
          <ErrorState text={phone.skillFailed} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows count={4} lines={2} label={phone.loadingSkill} />
        )}
      </Screen>
    );
  }

  const { item } = detail;
  const T = skillLibraryTextHere;
  const busy = toggle.isPending || restore.isPending || remove.isPending;
  const failed = (error: unknown) => Alert.alert(phone.failedChange, errorText(error, rawLocale));

  const askRestore = () =>
    ask(restoreConfirm(panel, item.status === 'removed', words, rawLocale), phone.cancel, () =>
      restore.mutate(
        { params, body: { name: item.name } },
        {
          onSuccess: (result) => {
            const text = outcomeText(result, rawLocale);
            if (text) return Alert.alert(text.title, text.body);
            if (result.status === 'ok') showNotice(T.restored(item.name));
          },
          onError: failed,
        },
      ),
    );
  const removing = removeConfirm(panel, words, rawLocale);
  const askRemove = () =>
    removing &&
    ask(removing, phone.cancel, () =>
      remove.mutate(
        { params, body: { name: item.name } },
        {
          onSuccess: (result) => {
            const text = outcomeText(result, rawLocale);
            if (text) return Alert.alert(text.title, text.body);
            if (result.status !== 'ok') return;
            showNotice(T.removed(item.name));
            // Nothing left to show (a removed built-in stays, Removed, with Restore).
            if (!result.data.item) goBack();
          },
          onError: failed,
        },
      ),
    );

  return (
    <Screen>
      <BackBar label={phone.title} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 28 + insets.bottom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              void query.refetch();
              void library.refetch();
            }}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 6 }}>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {panel.tag}
          </Text>
          <Text size={22} weight={600} mono lh={1.2} accessibilityRole="header">
            {panel.name}
          </Text>
          {panel.description ? (
            <Text size={15} lh={1.45} color={theme.colors.ink2}>
              {panel.description}
            </Text>
          ) : null}
          <View style={{ gap: 3, paddingTop: 4 }}>
            {panel.lines.map((line) => (
              <Text
                key={line}
                size={13}
                lh={1.4}
                color={line === T.updateLine ? theme.colors.warn : theme.colors.mut}
              >
                {line}
              </Text>
            ))}
            {panel.originalChanged ? (
              <Text size={13} lh={1.4} color={theme.colors.warn}>
                {panel.originalChanged}
              </Text>
            ) : null}
          </View>
        </View>

        {panel.canSwitch ? (
          <Section>
            <ListRow
              title={T.uses(words)}
              control={
                <Switch
                  value={panel.on}
                  disabled={toggle.isPending}
                  onValueChange={(on) =>
                    toggle.mutate(
                      { params, body: { name: item.name, on } },
                      { onSuccess: feedback.onResult, onError: feedback.onError },
                    )
                  }
                  accessibilityLabel={T.uses(words)}
                  accessibilityHint={phone.switchHint(item.name, words, panel.on)}
                  accessibilityRole="switch"
                  {...switchColors(theme, panel.on)}
                  style={{ minHeight: 44 }}
                />
              }
            />
          </Section>
        ) : null}

        {panel.canRestore || panel.removeKind ? (
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 14 }}>
            {panel.canRestore ? (
              <Button
                label={T.restore}
                variant="secondary"
                disabled={busy}
                busy={restore.isPending}
                onPress={askRestore}
                style={{ flex: 1 }}
              />
            ) : null}
            {panel.removeKind ? (
              <Button
                label={T.remove}
                variant="secondary"
                disabled={busy}
                busy={remove.isPending}
                onPress={askRemove}
                style={{ flex: 1 }}
              />
            ) : null}
          </View>
        ) : null}
        {panel.shownBody.trim() ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
            <View
              style={{
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
                padding: 16,
              }}
            >
              <RichText
                text={panel.shownBody}
                color={theme.colors.ink}
                accentColor={theme.colors.brand}
                codeBackground={theme.colors.sf2}
                size={14.5}
              />
            </View>
          </View>
        ) : null}

        {detail.files.length > 0 ? (
          <Section title={phone.files}>
            {detail.files.map((f) => (
              <ListRow key={f.path} title={f.path} titleMono trailing={fileBytes(f.bytes)} />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
