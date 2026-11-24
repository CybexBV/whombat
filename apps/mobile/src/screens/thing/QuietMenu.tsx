/**
 * A Worth a look line's ⋯ menu on the phone (Whombat quiet-notices.md QN-10…QN-13; quiet-notices-mobile.md AP-4861): a
 * bottom sheet in the message menu's language with the line's title on top, then **Ignore** with when you'll hear again
 * under it in the check's own words (“Until it’s back online.”), **Remind me tomorrow** and **Stop watching Hallway AP**
 * (or “Stop watching this”) with what that means under it (“Whombat won’t warn about it until you turn this back
 * on.”), each a 52dp row. A press closes the sheet at once; the line greys or goes on the page and
 * the toast says so with Undo (`useQuietActions`). The sheet is the shared `quietMenu`.
 */
import { LIMIT_WORDS, type LimitView, type QuietMenuView } from '@whombat/client';
import type { QuietActions, QuietTarget } from '@whombat/client/react';
import type { ComponentType } from 'react';
import { View } from 'react-native';
import { limitViewWords } from '../../data/monitoring';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { AlarmClock, BellOff, EyeOff, SlidersHorizontal } from '../../ui/icons';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';

type Icon = ComponentType<{ size: number; color: string; strokeWidth: number }>;

/** What the sheet is opened for: the line's menu and the line itself (the actions take it). */
export interface QuietMenuTarget {
  menu: QuietMenuView;
  line: QuietTarget;
  /** The limit of the check the line comes from, on a server (Whombat monitoring.md MON-15): Change the limit. */
  limit?: LimitView | null;
}

export function QuietMenuSheet({
  target,
  actions,
  onLimit = null,
  onClose,
}: {
  target: QuietMenuTarget | null;
  actions: QuietActions;
  /** Opens Change the limit for the line's check (a server's line with a limit). */
  onLimit?: ((view: LimitView) => void) | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const menu = target?.menu ?? null;
  const pick = (run: (line: QuietTarget) => void) => {
    if (!target) return;
    onClose();
    run(target.line);
  };
  return (
    <Sheet visible={!!target} onClose={onClose} label={menu?.label ?? ''}>
      {target && menu ? (
        <>
          <Text
            size={13.5}
            lh={1.4}
            color={theme.colors.mut}
            numberOfLines={2}
            style={{ paddingHorizontal: 22, paddingBottom: 12 }}
          >
            {target.line.title}
          </Text>
          <MenuRow
            icon={EyeOff}
            label={menu.ignore.label}
            words={menu.ignore.words}
            onPress={() => pick(actions.ignore)}
          />
          <MenuRow icon={AlarmClock} label={menu.snooze.label} onPress={() => pick(actions.snooze)} />
          <MenuRow
            icon={BellOff}
            label={menu.stop.label}
            words={menu.stop.words}
            onPress={() => pick(actions.stop)}
          />
          {target.limit && onLimit ? (
            <MenuRow
              icon={SlidersHorizontal}
              label={LIMIT_WORDS.menu}
              words={limitViewWords(target.limit)}
              onPress={() => {
                const view = target.limit;
                onClose();
                if (view) onLimit(view);
              }}
            />
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** A 52dp row: its icon, its words and what they mean under them (Ignore's: when you'll hear again). */
function MenuRow({
  icon: Icon,
  label,
  words,
  onPress,
}: {
  icon: Icon;
  label: string;
  words?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityLabel={label}
      accessibilityHint={words}
      style={{
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 22,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Icon size={19} color={theme.colors.ink2} strokeWidth={1.75} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={16} weight={500} numberOfLines={1}>
          {label}
        </Text>
        {words ? (
          <Text size={13} lh={1.35} color={theme.colors.mut} numberOfLines={2}>
            {words}
          </Text>
        ) : null}
      </View>
    </Touchable>
  );
}
