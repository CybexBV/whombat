/**
 * The app's menus (ios-native.md): on iPhone iOS's own (`modules/whombat-menu`) — a long press on a row opens the menu
 * where it was held, a tap on a ⋯ button opens the menu from it — and elsewhere the same choices in a sheet
 * (`MenuSheet`). Both take a `NativeMenuSpec` (`data/nativeMenu.ts`) and hand back the id picked, once the menu has gone.
 */
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useRef } from 'react';
import { type GestureResponderEvent, type StyleProp, View, type ViewStyle } from 'react-native';
import { NativeMenuView } from '../../modules/whombat-menu';
import type { NativeMenuItem, NativeMenuSpec } from '../data/nativeMenu';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, LinkIcon, type LucideIcon, Reply, Undo2 } from './icons';
import { Sheet } from './sheet';
import { Touchable } from './Touchable';

/** iOS's own menus are here (an iPhone build with the module); elsewhere a menu is a sheet. */
export const hasNativeMenu = NativeMenuView !== null;

type Pressing = {
  onPress?: (e: GestureResponderEvent) => void;
  onPressIn?: (e: GestureResponderEvent) => void;
};

/**
 * iOS's own menu round `children`. With a long press (default) `children` is one pressable row: a menu that opened
 * while the finger was down means letting go isn't a tap on the row. With a tap `children` is only what the button
 * looks like: the menu's own button takes the touch and VoiceOver reads `label`. Where there is no native menu,
 * `children` as it is: the caller opens its sheet.
 */
export function NativeMenu({
  spec,
  onPick,
  trigger = 'longPress',
  label,
  style,
  children,
}: {
  spec: NativeMenuSpec;
  onPick: (id: string) => void;
  trigger?: 'longPress' | 'tap';
  /** What VoiceOver calls the button, with a tap. */
  label?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const opened = useRef(false);
  if (!NativeMenuView) return <>{children}</>;
  let content = children;
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  if (trigger === 'longPress' && isValidElement<Pressing>(only)) {
    const row = only as ReactElement<Pressing>;
    content = cloneElement(row, {
      onPressIn: (e: GestureResponderEvent) => {
        opened.current = false;
        row.props.onPressIn?.(e);
      },
      ...(row.props.onPress
        ? {
            onPress: (e: GestureResponderEvent) => {
              if (!opened.current) row.props.onPress?.(e);
            },
          }
        : null),
    });
  } else if (trigger === 'tap') {
    content = (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={{ flexGrow: 1 }}
      >
        {children}
      </View>
    );
  }
  return (
    <NativeMenuView
      menu={JSON.stringify(spec)}
      trigger={trigger}
      {...(label ? { label } : {})}
      onMenuOpen={() => {
        opened.current = true;
      }}
      onMenuAction={(e) => onPick(e.nativeEvent.id)}
      {...(style ? { style } : {})}
    >
      {content}
    </NativeMenuView>
  );
}

/** The few symbols a sheet shows with the app's own icons; a line without one has none. */
const SHEET_ICONS: Record<string, LucideIcon> = {
  'arrow.uturn.backward.circle': Undo2,
  'arrowshape.turn.up.left': Reply,
  link: LinkIcon,
};

/**
 * A menu as a sheet (Android, and anywhere iOS's own isn't): its title on top, then 52dp rows with a line between
 * them, what a line means under it, the chosen one ticked, Delete red, and a submenu's choices under its name.
 */
export function MenuSheet({
  spec,
  visible,
  label,
  onClose,
  onPick,
}: {
  spec: NativeMenuSpec | null;
  visible: boolean;
  /** What TalkBack calls the sheet. */
  label: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const theme = useTheme();
  const pick = (id: string) => {
    onClose();
    onPick(id);
  };
  const rows = (items: readonly NativeMenuItem[]): ReactNode[] =>
    items.flatMap((item) =>
      item.children
        ? [
            <Text
              key={`${item.id}:head`}
              size={11}
              weight={500}
              mono
              tracking={0.05}
              color={theme.colors.mut}
              accessibilityRole="header"
              style={{ paddingHorizontal: 22, paddingTop: 14, paddingBottom: 8 }}
            >
              {item.title.toUpperCase()}
            </Text>,
            ...item.children.flatMap((group) => rows(group)),
          ]
        : [<MenuSheetRow key={item.id} item={item} onPress={() => pick(item.id)} />],
    );
  return (
    <Sheet visible={visible} onClose={onClose} label={label}>
      {spec?.title ? (
        <Text
          size={13.5}
          lh={1.4}
          color={theme.colors.mut}
          numberOfLines={2}
          style={{ paddingHorizontal: 22, paddingBottom: 12 }}
        >
          {spec.title}
        </Text>
      ) : null}
      {spec ? spec.sections.flatMap((group) => rows(group)) : null}
    </Sheet>
  );
}

function MenuSheetRow({ item, onPress }: { item: NativeMenuItem; onPress: () => void }) {
  const theme = useTheme();
  const Icon = item.icon ? SHEET_ICONS[item.icon] : undefined;
  const color = item.destructive ? theme.colors.bad : theme.colors.ink;
  return (
    <Touchable
      onPress={onPress}
      disabled={!!item.disabled}
      feedback="wash"
      accessibilityLabel={item.title}
      {...(item.subtitle ? { accessibilityHint: item.subtitle } : {})}
      {...(item.checked !== undefined ? { accessibilityState: { selected: item.checked } } : {})}
      style={{
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: 22,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        opacity: item.disabled ? 0.5 : 1,
      }}
    >
      {Icon ? (
        <Icon size={19} color={item.destructive ? theme.colors.bad : theme.colors.ink2} strokeWidth={1.75} />
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={16} weight={item.checked ? 600 : 500} numberOfLines={1} color={color}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text size={13} lh={1.35} color={theme.colors.mut} numberOfLines={2}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      {item.checked ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
    </Touchable>
  );
}
