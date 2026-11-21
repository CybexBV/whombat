/**
 * A screen's own page on the phone (Whombat desk-display.md DK-128, DK-137, DK-146, DK-147; desk-display-android.md
 * AP-6004…AP-6008), from Settings → Screens: what it is under its name; its name to change (not the box's own: it has
 * the Whombat's); *Edit layout* with its pages and grid; *What pops up* (the three, saved at once). The box's own screen
 * keeps what the older *Screen* page had beyond the layout — the unlock request, *Show Whombat on this screen* and its
 * pairing, and as tabs *Top bar* (with *Welcome back* and *Done today*), *Lock and PIN*, *Night* and *Talk*
 * (`?part=night` opens one). A screen elsewhere ends with *Remove*, a monitor on the box with forgetting its layout,
 * each asked first.
 */
import { type RouteProp, useRoute } from '@react-navigation/native';
import {
  DESK_SCREENS_TEXT,
  DESK_WORDS,
  type DeskApi,
  type DeskPopups,
  type DeskScreenDetail,
  type DeskShowPatch,
  deskErrorText,
  deskLockAgainOf,
  deskSectionShown,
  fillDeskWords,
  screensErrorText,
} from '@whombat/client/desk';
import { useDesk, useDeskActions, useDeskScreen, useDeskScreenActions } from '@whombat/client/desk/react';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { toasts } from '../../data/toast';
import { useAgentWords } from '../../data/useAgent';
import { DeskLockCard, DeskNightCard, DeskSwitchCard, DeskTalkCard } from '../../managed/DeskSection';
import { DeskUnlockCard } from '../../managed/DeskUnlockCard';
import { Card, Field, LinkRow } from '../../managed/ui';
import { useDeskApi } from '../../managed/useDesk';
import { useAppNavigation } from '../../navigation/hooks';
import type { RootStackParamList } from '../../navigation/routes';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Button, ErrorState, Loading, SectionLabel } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { UnderlineTabs } from '../../ui/UnderlineTabs';
import { DeskAroundCard, DeskBarCard } from '../DeskShowsPart';
import { SettingsPage } from '../SettingsPages';
import { useDeskNameSync } from '../useDeskName';
import {
  BOX_PART_LABELS,
  type BoxPart,
  boxParts,
  layoutLine,
  popupOptions,
  screenName,
  screenRow,
} from './screensList';

const P = DESK_SCREENS_TEXT.page;
const failed = (error: unknown) => Alert.alert('That didn’t go through', screensErrorText(error));

export function SettingsScreenPage() {
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsScreen'>>();
  const id = route.params.screen;
  const api = useDeskApi();
  const detail = useDeskScreen(api, id);
  const screen = detail.data;
  return (
    <SettingsPage title={screen?.name ?? DESK_SCREENS_TEXT.title} back={DESK_SCREENS_TEXT.back}>
      {api && screen ? (
        <ScreenParts api={api} screen={screen} part={route.params.part} />
      ) : detail.error ? (
        <ErrorState text={screensErrorText(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <Loading />
      )}
    </SettingsPage>
  );
}

function ScreenParts({
  api,
  screen,
  part,
}: {
  api: DeskApi;
  screen: DeskScreenDetail;
  part?: string | undefined;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const assistant = useAgentWords().name;
  const { timeZone } = useBurrowBase();
  const actions = useDeskScreenActions(api);
  const desk = useDesk(api).data;
  const row = screenRow(screen, screen, {
    box: desk?.display ?? null,
    lockAgain: desk?.paired ? deskLockAgainOf(desk.settings) : null,
    lockedView: desk?.settings.lockedView ?? null,
    now: Date.now(),
    timeZone,
  });
  const box = screen.kind === 'box';
  const setPopups = (popups: DeskPopups) => void actions.update({ screen: screen.id, popups }).catch(failed);
  return (
    <>
      <Text size={14} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6, marginTop: -12 }}>
        {[row.what, row.status].filter(Boolean).join('\n')}
      </Text>
      {box ? <BoxTop api={api} /> : <NameCard api={api} screen={screen} />}
      <Card>
        <LinkRow
          first
          title={DESK_SCREENS_TEXT.editLayout}
          meta={layoutLine(screen)}
          label={`${DESK_SCREENS_TEXT.editLayout}, ${layoutLine(screen)}`}
          onPress={() =>
            navigation.navigate('SettingsScreenLayout', { screen: screen.id, back: screen.name })
          }
        />
      </Card>
      <View style={{ gap: 8 }}>
        <SectionLabel>{P.popups.toUpperCase()}</SectionLabel>
        <Segmented<DeskPopups>
          options={popupOptions()}
          value={screen.popups}
          onChange={setPopups}
          label={P.popups}
          lines={2}
        />
        <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {fillDeskWords(P.popupsHint[screen.popups], { assistant })}
        </Text>
      </View>
      {box ? <BoxParts api={api} asked={part} /> : <RemoveCard api={api} screen={screen} />}
    </>
  );
}

/**
 * The box's own screen's top (the older *Screen* page's): the unlock request, then *Show Whombat on this screen* with
 * the screen line and its pairing. Opening it gives the screen the Whombat's name (DK-119).
 */
function BoxTop({ api }: { api: DeskApi }) {
  const desk = useDesk(api);
  const actions = useDeskActions(api);
  useDeskNameSync(api, desk.data);
  const screen = desk.data;
  if (!screen || !deskSectionShown(screen)) return <DeskUnlockCard api={api} />;
  return (
    <>
      <DeskUnlockCard api={api} />
      <DeskSwitchCard screen={screen} actions={actions} />
    </>
  );
}

/** A screen elsewhere's or a monitor's name: saved when the field is left or Done is pressed. */
function NameCard({ api, screen }: { api: DeskApi; screen: DeskScreenDetail }) {
  const actions = useDeskScreenActions(api);
  const [name, setName] = useState(screen.name);
  useEffect(() => setName(screen.name), [screen.name]);
  const save = () => {
    const clean = screenName(name);
    if (!clean || clean === screen.name) return setName(screen.name);
    actions.update({ screen: screen.id, name: clean }).then(() => toasts.show(P.saved), failed);
  };
  return (
    <Field
      label={P.name}
      value={name}
      onChangeText={setName}
      onEndEditing={save}
      onSubmitEditing={save}
      returnKeyType="done"
      maxLength={60}
      hint={P.nameHint}
    />
  );
}

/**
 * The box's own parts as tabs (the older page's, without *What it shows*: its choices are the widgets' now): *Top
 * bar* — the top bar's choices, *Welcome back* and *Done today* — then *Lock and PIN*, *Night* and *Talk*; none until
 * the screen is paired, as before.
 */
function BoxParts({ api, asked }: { api: DeskApi; asked?: string | undefined }) {
  const desk = useDesk(api);
  const actions = useDeskActions(api);
  const screen = desk.data;
  const parts = screen ? boxParts(screen) : [];
  const [chosen, setChosen] = useState<BoxPart | null>(null);
  const part =
    chosen && parts.includes(chosen) ? chosen : (parts.find((p) => p === asked) ?? parts[0] ?? null);
  if (!screen || !part) return null;
  const save = (patch: DeskShowPatch) =>
    void actions
      .update({ show: patch })
      .catch((e: unknown) => Alert.alert('That didn’t go through', deskErrorText(e)));
  return (
    <>
      <View style={{ marginTop: -2 }}>
        <UnderlineTabs<BoxPart>
          tabs={parts.map((key) => ({ key, label: BOX_PART_LABELS[key] }))}
          value={part}
          onChange={setChosen}
          label={DESK_WORDS.settings.tab}
          bleed={16}
        />
      </View>
      {part === 'bar' ? (
        <>
          <DeskBarCard show={screen.settings.show} onPatch={save} />
          <DeskAroundCard show={screen.settings.show} onPatch={save} />
        </>
      ) : part === 'lock' ? (
        <DeskLockCard screen={screen} actions={actions} />
      ) : part === 'night' ? (
        <DeskNightCard screen={screen} actions={actions} />
      ) : (
        <DeskTalkCard api={api} screen={screen} actions={actions} />
      )}
    </>
  );
}

/**
 * *Remove* (DK-146): a screen elsewhere stops at once and its device goes back to *Use as a screen*; a monitor on the
 * box forgets its layout. Asked first; then back to the list.
 */
function RemoveCard({ api, screen }: { api: DeskApi; screen: DeskScreenDetail }) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const actions = useDeskScreenActions(api);
  const output = screen.kind === 'output';
  const line = output ? P.removeOutput : P.removeLine;
  const remove = () =>
    Alert.alert(fillDeskWords(P.removeTitle, { name: screen.name }), line, [
      { text: DESK_SCREENS_TEXT.addDialog.cancel, style: 'cancel' },
      {
        text: P.removeConfirm,
        style: 'destructive',
        onPress: () =>
          void actions.remove(screen.id).then(() => {
            toasts.show(output ? P.forgotten : fillDeskWords(P.removed, { name: screen.name }));
            navigation.goBack();
          }, failed),
      },
    ]);
  return (
    <Card>
      <View style={{ gap: 10, paddingVertical: 14, paddingHorizontal: 16 }}>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {line}
        </Text>
        <Button
          label={P.remove}
          variant="secondary"
          accessibilityLabel={`${P.remove} ${screen.name}`}
          onPress={remove}
        />
      </View>
    </Card>
  );
}
