/**
 * Stop on a live card, stepped back so it isn't pressed by mistake: a quiet word with a small square at the bottom right of a council's or a checklist's card, and the card's ⋯ on its status line
 * with Council settings and Stop…. Both still ask first (the screen's Alert).
 */
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { liveCardMenu, parseLiveCardPick } from '../data/workLine';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { CARD_TARGET } from './cardFrame';
import { Ellipsis } from './icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from './nativeMenu';
import { Touchable } from './Touchable';

/** “□ Stop”: a text button in `ink2`, a 44pt target, never a full-width button above the work. */
export function CardStopButton({
  label,
  spoken,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  /** Whose Stop, for a screen reader (“Stop the council”). */
  spoken: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled || busy}
      feedback="wash"
      ringRadius={theme.radii.button}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={{
        minHeight: CARD_TARGET,
        minWidth: CARD_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 8,
        marginRight: -8,
        borderRadius: theme.radii.button,
        opacity: disabled && !busy ? 0.5 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.ink2} />
      ) : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ width: 9, height: 9, borderRadius: 2, borderWidth: 1.5, borderColor: theme.colors.ink2 }}
        />
      )}
      <Text size={13.5} weight={500} color={theme.colors.ink2}>
        {label}
      </Text>
    </Touchable>
  );
}

/** A live card's ⋯ on its status line: iOS's own menu on iPhone, a sheet elsewhere. */
export function CardCornerMenu({
  title,
  onChange,
  onStop,
}: {
  /** The card's title, the menu's quiet heading. */
  title: string;
  /** Council settings (a council); null: not on this card. */
  onChange: (() => void) | null;
  /** Stop… (asks first); null while it can't stop. */
  onStop: (() => void) | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (!onChange && !onStop) return null;
  const menu = { ...liveCardMenu({ change: !!onChange, stop: !!onStop, locale: rawLocale }), title };
  const pick = (id: string) => {
    const what = parseLiveCardPick(id);
    if (what === 'change') onChange?.();
    else if (what === 'stop') onStop?.();
  };
  const style = {
    width: CARD_TARGET,
    height: CARD_TARGET,
    borderRadius: CARD_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: -12,
    marginRight: -12,
  } as const;
  const face = <Ellipsis size={18} color={theme.colors.ink2} strokeWidth={1.75} />;
  return hasNativeMenu ? (
    <NativeMenu spec={menu} onPick={pick} trigger="tap" label={tMobile('screens2.ui.cardMore')} style={style}>
      <View style={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}>{face}</View>
    </NativeMenu>
  ) : (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        ringRadius={CARD_TARGET / 2}
        accessibilityRole="button"
        accessibilityLabel={tMobile('screens2.ui.cardMore')}
        style={style}
      >
        {face}
      </Touchable>
      <MenuSheet
        spec={menu}
        visible={open}
        label={tMobile('screens2.ui.cardMore')}
        onClose={() => setOpen(false)}
        onPick={pick}
      />
    </>
  );
}
