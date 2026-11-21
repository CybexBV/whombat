/**
 * A thing page's buttons on the phone (contracts 0.121, CT-1001…CT-1006; Whombat service-dashboards.md SD-07…SD-09;
 * service-dashboards.md AP-4630…AP-4635): small outlined buttons with their icon first (32dp, padded to 44) on a panel's
 * head, a row, a gallery item and a control, the head's own beside Restart (44dp); `primary` filled, `danger` in the
 * bad colour. Pressing one runs it through the page's one runner (`useThingButtons`): one with a question opens the
 * question sheet, the toast says the server's words. A button the viewer may not press stays in place, greyed, and
 * still answers a press — with the server's reason as a toast (TalkBack hears it as the hint); it is never hidden.
 * While its answer is on its way it shows a spinner where its icon was, so its width doesn't change.
 */
import { thingButtonKey, thingButtonView } from '@whombat/client';
import type { ThingButtons } from '@whombat/client/react';
import type { ThingButtonIcon, ThingButtonValue, ThingPageButton } from '@whombat/core';
import { ActivityIndicator, View } from 'react-native';
import { buttonHint } from '../../data/servicePanels';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Eraser,
  Gauge,
  Lock,
  LockOpen,
  type LucideIcon,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Square,
  X,
} from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { showNotice } from '../feedback';

/** Each button icon in Lucide, as on the web (AP-4566); a name this app doesn't know draws none. */
const BUTTON_ICONS: Record<ThingButtonIcon, LucideIcon> = {
  restart: RotateCcw,
  power: Power,
  play: Play,
  pause: Pause,
  stop: Square,
  check: Check,
  close: X,
  retry: RefreshCw,
  search: Search,
  lock: Lock,
  unlock: LockOpen,
  shield: Shield,
  up: ArrowUp,
  down: ArrowDown,
  open: ArrowUpFromLine,
  clean: Eraser,
  speed: Gauge,
};

export interface ThingButtonProps {
  button: ThingPageButton;
  /** The page's runner (`useThingButtons`). */
  act: ThingButtons;
  /** What it sends instead of its own value (a stepper's figure). */
  value?: ThingButtonValue;
  /** TalkBack's name when the label alone isn't enough (“Scan Movies”). */
  spoken?: string;
  /** Take the width it is given (a poster's buttons, one under the other). */
  stretch?: boolean;
}

function useLook(button: ThingPageButton, act: ThingButtons, value: ThingButtonValue | undefined) {
  const theme = useTheme();
  const view = thingButtonView(button);
  const busy = act.running(button, value);
  const primary = view.tone === 'primary' && !view.disabled;
  const fg = primary ? theme.colors.btnfg : view.tone === 'danger' ? theme.colors.bad : theme.colors.ink;
  const Icon = view.icon ? (BUTTON_ICONS[view.icon] ?? null) : null;
  const press = () => {
    if (view.disabled) {
      if (view.reason) showNotice(view.reason);
      return;
    }
    act.press(button, value === undefined ? {} : { value });
  };
  return {
    view,
    busy,
    primary,
    fg,
    Icon,
    press,
    border: view.tone === 'danger' && !view.disabled ? theme.colors.bad : theme.colors.line2,
    background: primary ? theme.colors.btn : 'transparent',
  };
}

/** The icon, or a spinner in its place while the button runs. */
function Lead({
  Icon,
  busy,
  color,
  size,
}: {
  Icon: LucideIcon | null;
  busy: boolean;
  color: string;
  size: number;
}) {
  if (busy) return <ActivityIndicator size="small" color={color} style={{ width: size, height: size }} />;
  if (!Icon) return null;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon size={size} color={color} strokeWidth={1.9} />
    </View>
  );
}

/** A small button (32dp, padded to 44): a panel's head, a row, a gallery item, a control. */
export function ThingButton({ button, act, value, spoken, stretch = false }: ThingButtonProps) {
  const look = useLook(button, act, value);
  return (
    <Touchable
      onPress={look.press}
      disabled={look.busy}
      feedback={look.primary ? 'fade' : 'wash'}
      ringRadius={8}
      accessibilityRole="button"
      accessibilityLabel={spoken ?? look.view.label}
      accessibilityHint={buttonHint(look.view)}
      accessibilityState={{ disabled: look.view.disabled, busy: look.busy }}
      hitSlop={hitSlopFor(32)}
      style={{
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: look.primary ? 0 : 1,
        borderColor: look.border,
        backgroundColor: look.background,
        opacity: look.view.disabled ? 0.45 : 1,
        ...(stretch ? { alignSelf: 'stretch' as const } : { alignSelf: 'flex-start' as const }),
      }}
    >
      <Lead Icon={look.Icon} busy={look.busy} color={look.fg} size={14} />
      <Text size={13} weight={500} color={look.fg} numberOfLines={1} style={{ flexShrink: 1 }}>
        {look.view.label}
      </Text>
    </Touchable>
  );
}

/**
 * A button drawn as its icon alone where its words would crowd (a library's Scan on its tile): 30dp, padded to 44, in
 * `mut`, named for VoiceOver and TalkBack by `spoken` (“Scan Movies”). Greyed and answering with its reason as the
 * others do.
 */
export function ThingIconButton({
  button,
  act,
  spoken,
}: {
  button: ThingPageButton;
  act: ThingButtons;
  spoken: string;
}) {
  const theme = useTheme();
  const look = useLook(button, act, undefined);
  return (
    <Touchable
      onPress={look.press}
      disabled={look.busy}
      feedback="wash"
      ringRadius={9}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={buttonHint(look.view)}
      accessibilityState={{ disabled: look.view.disabled, busy: look.busy }}
      hitSlop={hitSlopFor(30)}
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: look.view.disabled ? 0.45 : 1,
      }}
    >
      <Lead Icon={look.Icon ?? RefreshCw} busy={look.busy} color={theme.colors.mut} size={15} />
    </Touchable>
  );
}

/** A page's own button in its head (CT-1014: Check for updates, Arm), beside Restart: 44dp, as the head's Buttons. */
export function HeadButton({
  button,
  act,
  onPressed,
}: {
  button: ThingPageButton;
  act: ThingButtons;
  /** Before it runs (the menu it sits in closes first, so its question isn't hidden behind it). */
  onPressed?: () => void;
}) {
  const look = useLook(button, act, undefined);
  return (
    <Touchable
      onPress={() => {
        onPressed?.();
        look.press();
      }}
      disabled={look.busy}
      feedback={look.primary ? 'fade' : 'wash'}
      ringRadius={12}
      accessibilityRole="button"
      accessibilityLabel={look.view.label}
      accessibilityHint={buttonHint(look.view)}
      accessibilityState={{ disabled: look.view.disabled, busy: look.busy }}
      style={{
        minHeight: 44,
        flexGrow: 1,
        flexBasis: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: look.primary ? 0 : 1,
        borderColor: look.border,
        backgroundColor: look.background,
        opacity: look.view.disabled ? 0.45 : 1,
      }}
    >
      <Lead Icon={look.Icon} busy={look.busy} color={look.fg} size={16} />
      <Text size={15} weight={500} color={look.fg} numberOfLines={1} style={{ flexShrink: 1 }}>
        {look.view.label}
      </Text>
    </Touchable>
  );
}

/** A panel's head buttons (CT-1003; Pause, Pause 30 min, Retry all), in a row under its title that wraps. */
export function PanelButtons({
  buttons,
  act,
}: {
  buttons: readonly ThingPageButton[] | undefined;
  act: ThingButtons | null | undefined;
}) {
  if (!buttons?.length || !act) return null;
  return (
    <View
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}
    >
      {buttons.map((b) => (
        <ThingButton key={thingButtonKey(b)} button={b} act={act} />
      ))}
    </View>
  );
}

/** A row's or an item's buttons (CT-1002), side by side and wrapping; `column` one under the other (a poster). */
export function ItemButtons({
  buttons,
  act,
  about,
  column = false,
}: {
  buttons: readonly ThingPageButton[];
  act: ThingButtons | null | undefined;
  /** What they are on (“Dune: Part Two”): TalkBack hears “Approve Dune: Part Two”. */
  about: string;
  column?: boolean;
}) {
  if (!buttons.length || !act) return null;
  return (
    <View style={column ? { gap: 8 } : { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {buttons.map((b) => (
        <ThingButton
          key={thingButtonKey(b)}
          button={b}
          act={act}
          spoken={`${b.label} ${about}`}
          stretch={column}
        />
      ))}
    </View>
  );
}
