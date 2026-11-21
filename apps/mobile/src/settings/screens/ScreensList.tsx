/**
 * Settings → Screens on the phone (Whombat desk-display.md DK-128, DK-146, DK-147; desk-display-android.md
 * AP-6000…AP-6003; the mockups' `f-screens`): the line under the title, then every screen — the box's own first, a
 * monitor on the box, the tablets and computers elsewhere — as a card row with its name and the shared lines (what it
 * is, its grid and pages; what pops up and how it locks; since when it isn't showing), opening its page, with *Edit
 * layout* beside it; then *Add a screen*, which opens its sheet (or says why not when there are as many as can be).
 */
import { DESK_SCREENS_TEXT, type DeskApi, type DeskScreensList, deskLockAgainOf } from '@whombat/client/desk';
import { useDesk, useDeskScreen } from '@whombat/client/desk/react';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { DeskUnlockCard } from '../../managed/DeskUnlockCard';
import { useAppNavigation } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ChevronRight, Monitor, Tablet } from '../../ui/icons';
import { Button } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';
import { AddScreenSheet } from './AddScreenSheet';
import { screenRow } from './screensList';
import { PHONE_SCREENS_TEXT } from './tiles';

export function ScreensList({ api, list }: { api: DeskApi; list: DeskScreensList }) {
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <DeskUnlockCard api={api} />
      <Text size={14} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6, marginTop: -10 }}>
        {DESK_SCREENS_TEXT.intro}
      </Text>
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        {list.screens.map((s, i) => (
          <ScreenRow key={s.id} api={api} screen={s} first={i === 0} />
        ))}
      </View>
      <View style={{ gap: 6 }}>
        <Button
          label={PHONE_SCREENS_TEXT.add}
          variant="secondary"
          disabled={!list.canAdd}
          onPress={() => setAdding(true)}
          accessibilityHint={list.canAdd ? PHONE_SCREENS_TEXT.addHint : PHONE_SCREENS_TEXT.full}
        />
        <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {list.canAdd ? PHONE_SCREENS_TEXT.addHint : PHONE_SCREENS_TEXT.full}
        </Text>
      </View>
      <AddScreenSheet api={api} visible={adding} onClose={() => setAdding(false)} />
    </>
  );
}

/**
 * A screen's row: its icon, name and lines (one button that opens its page, read as all of it), and *Edit layout*
 * (44dp) under the lines: beside them a phone's width leaves the lines too little room.
 */
function ScreenRow({
  api,
  screen,
  first,
}: {
  api: DeskApi;
  screen: DeskScreensList['screens'][number];
  first: boolean;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const { timeZone } = useBurrowBase();
  const detail = useDeskScreen(api, screen.id).data;
  const desk = useDesk(api).data;
  const row = screenRow(screen, detail, {
    box: desk?.display ?? null,
    lockAgain: desk?.paired ? deskLockAgainOf(desk.settings) : null,
    lockedView: desk?.settings.lockedView ?? null,
    now: Date.now(),
    timeZone,
  });
  const Icon = screen.kind === 'device' ? Tablet : Monitor;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: theme.colors.line }}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={row.spoken}
        feedback="wash"
        onPress={() => navigation.navigate('SettingsScreen', { screen: screen.id })}
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          minHeight: 72,
          paddingTop: 14,
          paddingBottom: 10,
          paddingLeft: 16,
          paddingRight: 14,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon size={19} color={theme.colors.ink2} strokeWidth={1.75} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={15} weight={600} lh={1.35}>
            {row.name}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.ink2}>
            {row.what}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {row.how}
          </Text>
          {row.status ? (
            <Text size={13} lh={1.4} color={theme.colors.warn}>
              {row.status}
            </Text>
          ) : null}
        </View>
        <ChevronRight size={18} color={theme.colors.mut} style={{ marginTop: 9 }} />
      </Touchable>
      <View style={{ paddingLeft: 64, paddingBottom: 14, alignItems: 'flex-start' }}>
        <Button
          label={DESK_SCREENS_TEXT.editLayout}
          variant="secondary"
          accessibilityLabel={`${DESK_SCREENS_TEXT.editLayout}, ${row.name}`}
          onPress={() =>
            navigation.navigate('SettingsScreenLayout', { screen: screen.id, back: DESK_SCREENS_TEXT.back })
          }
          style={{ paddingHorizontal: 16 }}
        />
      </View>
    </View>
  );
}
