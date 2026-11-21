/**
 * A widget's mark in the editor's sheets (desk-display-android.md AP-6016, AP-6121): a connection's or a server's brand
 * where `@whombat/brand` has it (`ConnectionLogo`), an icon for what it shows where that says more than its type (an
 * account's calendar, mail or pull requests, a photo, a board), its type's icon for Whombat's own and the rest, else
 * the first letter of what it belongs to. Decorative: its name is always beside it.
 */
import { isBrandMark } from '@whombat/brand';
import type { DeskWidgetType } from '@whombat/client/desk';
import { View } from 'react-native';
import { useTheme } from '../../theme/theme';
import { ConnectionLogo } from '../../ui/ConnectionLogo';
import {
  Activity,
  Calendar,
  CalendarClock,
  Check,
  Clock,
  Columns2,
  Gauge,
  GitPullRequest,
  Grid3x3,
  ImageIcon,
  LayoutGrid,
  type LucideIcon,
  Mail,
  Server,
  Sparkles,
} from '../../ui/icons';
import type { AccountShows } from './catalog';

export const WIDGET_ICONS: Record<DeskWidgetType, LucideIcon> = {
  clock: Clock,
  status: Activity,
  now: Columns2,
  strip: Server,
  work: Sparkles,
  coming: CalendarClock,
  done: Check,
  server: Server,
  figures: Gauge,
  panel: LayoutGrid,
  widget: Sparkles,
};

/** What a widget draws, where that says more than its type: a picture, a grid of tiles. Other kinds have none. */
export const VIEW_ICONS: Readonly<Partial<Record<string, LucideIcon>>> = {
  photo: ImageIcon,
  board: Grid3x3,
};

/** What an account's widget shows, where its item has no brand mark of its own. */
export const ACCOUNT_ICONS: Readonly<Record<AccountShows, LucideIcon>> = {
  calendar: Calendar,
  mail: Mail,
  pulls: GitPullRequest,
};

/** A widget's icon without a mark: what it draws (a photo, a board) where that says it, else its type's. */
export const widgetIcon = (type: DeskWidgetType, view?: string | null): LucideIcon =>
  (view ? VIEW_ICONS[view] : undefined) ?? WIDGET_ICONS[type];

export function WidgetLogo({
  type,
  mark,
  name,
  icon,
  size = 32,
}: {
  type: DeskWidgetType;
  mark?: string | null | undefined;
  name: string;
  /** The icon where it has no brand mark, instead of its type's (an account's calendar, a photo). */
  icon?: LucideIcon | undefined;
  size?: number;
}) {
  const theme = useTheme();
  if (mark && isBrandMark(mark)) return <ConnectionLogo logo={{ kind: 'mark', mark }} size={size} />;
  if (mark && type !== 'server' && !icon)
    return <ConnectionLogo logo={{ kind: 'monogram', letter: name.slice(0, 1).toUpperCase() }} size={size} />;
  const Icon = icon ?? WIDGET_ICONS[type];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={Math.round(size / 2)} color={theme.colors.ink2} strokeWidth={1.75} />
    </View>
  );
}
