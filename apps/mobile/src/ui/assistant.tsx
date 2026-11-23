/**
 * The one-Whombat shell's pieces on the phone (mock 4; one-whombat-mobile.md AP-1352…AP-1356): the 16dp-radius cards
 * with a mono label and a count, their 52dp rows (a dot or a glyph, a 15/600 title over a 13 line, a chevron), the
 * status dots (a dashed ring while a device is learned), a thing's glyph, the tone badge (“Needs you · pve-02”) and the
 * sheet's big buttons (52dp, radius 12). Colours only from the theme.
 */
import type { MarkLike } from '@whombat/brand';
import { THING_STATUS_LABELS } from '@whombat/client';
import type { HomeSeverity, ThingStatus } from '@whombat/core';
import { createContext, type ReactNode, useContext } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { PhoneGlyph } from '../data/thingLook';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { tint } from './glanceColors';
import {
  Calendar,
  ChevronRight,
  CircleDashed,
  Cloud,
  Code2,
  House,
  type LucideIcon,
  Mail,
  MessageSquare,
  Plug,
  Server,
  Thermometer,
  Wifi,
} from './icons';
import { useLargeText } from './largeText';
import { Touchable } from './Touchable';

type Theme = ReturnType<typeof useTheme>;

/** A tone's colour: `bad`, `warn`, `ok`; anything else `mut`. */
export function toneOf(theme: Theme, tone: HomeSeverity | ThingStatus | 'ok' | null | undefined): string {
  switch (tone) {
    case 'bad':
      return theme.colors.bad;
    case 'warn':
      return theme.colors.warn;
    case 'ok':
      return theme.colors.ok;
    default:
      return theme.colors.mut;
  }
}

const GLYPH_ICONS: Record<PhoneGlyph, LucideIcon> = {
  server: Server,
  home: House,
  thermometer: Thermometer,
  wifi: Wifi,
  cloud: Cloud,
  mail: Mail,
  calendar: Calendar,
  device: Thermometer,
  plug: Plug,
  code: Code2,
  // Website feedback (`phoneThingGlyph`): its logo tile's bubble.
  message: MessageSquare,
};

/**
 * A thing's icon: its maker's mark when it has one (a server's Debian or Proxmox, a connection's provider; marks.md
 * AP-2205), else its glyph (mock 4's 18dp line icons in `mut`). Decorative: the row says what it is.
 */
export function ThingIcon({
  glyph,
  mark,
  size = 20,
  color,
}: {
  glyph: PhoneGlyph;
  mark?: MarkLike | null;
  size?: number;
  color?: string;
}) {
  const theme = useTheme();
  const Icon = GLYPH_ICONS[glyph];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {mark ? (
        <BrandMark mark={mark} size={size} />
      ) : (
        <Icon size={size} color={color ?? theme.colors.mut} strokeWidth={1.7} />
      )}
    </View>
  );
}

/**
 * The 8dp dot of a status or severity; a dashed 9dp ring in `brand` for a device Whombat is learning (mock 4's heat
 * pump). With `label` it is read on its own; without, it is decorative (the row's label says it).
 */
export function Dot({
  tone,
  learning = false,
  label,
}: {
  tone: HomeSeverity | ThingStatus | 'ok' | null;
  learning?: boolean;
  label?: string;
}) {
  const theme = useTheme();
  const a11y = label
    ? { accessible: true, accessibilityLabel: label }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  if (learning)
    return (
      <View {...a11y} style={{ width: 10, height: 10, alignItems: 'center', justifyContent: 'center' }}>
        <CircleDashed size={11} color={theme.colors.brand} strokeWidth={2} />
      </View>
    );
  return (
    <View {...a11y} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneOf(theme, tone) }} />
  );
}

/** A thing's status dot with its words for TalkBack (“Needs a look”). */
export function ThingDot({ status, spoken = false }: { status: ThingStatus; spoken?: boolean }) {
  return (
    <Dot
      tone={status}
      learning={status === 'learning'}
      {...(spoken ? { label: THING_STATUS_LABELS[status] } : {})}
    />
  );
}

/** `NEEDS YOU` — DM Mono 500 11px, .05em, uppercase, `mut`. */
export function MonoLabel({ children, color }: { children: string; color?: string }) {
  const theme = useTheme();
  return (
    <Text
      size={11}
      weight={500}
      mono
      tracking={0.05}
      uppercase
      color={color ?? theme.colors.mut}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}

/** A tone pill (mock `.badge`): mono 11/500 in the tone on a 14 % wash; `mut` on `sf2`. */
export function ToneBadge({ text, tone }: { text: string; tone: HomeSeverity | 'ok' | 'mut' | 'brand' }) {
  const theme = useTheme();
  const color =
    tone === 'mut' || tone === 'info'
      ? theme.colors.ink2
      : tone === 'brand'
        ? theme.colors.brand
        : toneOf(theme, tone);
  const background = tone === 'mut' || tone === 'info' ? theme.colors.sf2 : tint(color, 0.14);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingVertical: 2,
        paddingHorizontal: 9,
        backgroundColor: background,
      }}
    >
      <Text size={11} weight={500} mono color={color}>
        {text}
      </Text>
    </View>
  );
}

/**
 * What the card right under it adds to its head after its own `right`: a page's card's “Ask” (Whombat
 * service-settings.md SST-08), set by the page's panel renderer so every card kind gets it. Cards inside that card don't.
 */
export const OneCardAside = createContext<ReactNode>(null);

/**
 * How a card says its title: a mono label (mock 4), or a heading with its grey words beside it (a service's Summary in
 * slots, Whombat service-slots.md SLT-01). The page sets it for every card on it, so they read as one.
 */
export type OneCardLook = 'label' | 'heading';
export const OneCardLookContext = createContext<OneCardLook>('label');

/**
 * Mock 4's card: `sf`, a `line` border, 16dp radius; its header (label left, `right` right) 12 14 4, then `meta`'s grey
 * words under it. In the heading look the title is 17/700 with `meta` beside it, and the card's corners are rounder.
 */
export function OneCard({
  label,
  meta,
  right,
  children,
}: {
  label?: string;
  /** Grey words about the card (“3 streams · 52 Mb/s out”). */
  meta?: string | null | undefined;
  right?: ReactNode;
  children: ReactNode;
}) {
  const theme = useTheme();
  const aside = useContext(OneCardAside);
  const heading = useContext(OneCardLookContext) === 'heading';
  const words = meta?.trim() || null;
  const end =
    right && aside ? (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
        {right}
        {aside}
      </View>
    ) : (
      (right ?? aside)
    );
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: heading ? 18 : 16,
        overflow: 'hidden',
      }}
    >
      {label && heading ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingTop: 12,
            paddingHorizontal: 14,
            paddingBottom: 8,
            minHeight: 44,
          }}
        >
          <Text size={17} weight={700} tracking={-0.01} numberOfLines={1} accessibilityRole="header">
            {label}
          </Text>
          <Text size={13} color={theme.colors.mut} numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
            {words ?? ''}
          </Text>
          {end}
        </View>
      ) : label ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 12,
            paddingHorizontal: 14,
            paddingBottom: 8,
            minHeight: 36,
          }}
        >
          <MonoLabel>{label}</MonoLabel>
          {end}
        </View>
      ) : null}
      {words && !(label && heading) ? (
        <Text
          size={13}
          color={theme.colors.mut}
          style={{ paddingHorizontal: 14, paddingBottom: 10, marginTop: -4 }}
        >
          {words}
        </Text>
      ) : null}
      {aside ? <OneCardAside.Provider value={null}>{children}</OneCardAside.Provider> : children}
    </View>
  );
}

/**
 * A card row (mock `.prow`): 52dp min, a leading dot or glyph, a 15/600 title over a 13 `mut` line, and at the end a
 * dot or a chevron; a top hairline. The whole row is one button named by `label`.
 */
export function OneRow({
  leading,
  title,
  titleMono = false,
  titleLines = 2,
  titleAfter,
  line,
  meta,
  badge,
  trailing,
  chevron = false,
  onPress,
  label,
  hint,
  first = false,
  selected = false,
}: {
  leading?: ReactNode;
  title: string;
  titleMono?: boolean;
  /** How many lines the title may take before it ellipsises; two by default (a guest's name too, AP-2562). */
  titleLines?: number;
  /** Muted words right after the title that never ellipsise (a Proxmox guest's number, AP-1755). */
  titleAfter?: string | null;
  line?: string | null;
  /** A mono line under it (`pve-02 · 14:05`). */
  meta?: string | null;
  /** A small pill under the lines (“This Whombat”, incus-unraid-mobile.md AP-1639); decorative, `label` says it. */
  badge?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  label: string;
  hint?: string;
  /** The first row under a card without a header has no hairline above it. */
  first?: boolean;
  /** What the right page shows, with two pages: marked as a list marks what it opened. */
  selected?: boolean;
}) {
  const theme = useTheme();
  const content = (
    <>
      {leading ? (
        <View style={{ width: 20, alignItems: 'center', justifyContent: 'center' }}>{leading}</View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {titleAfter ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <Text
              size={titleMono ? 14.5 : 15}
              weight={titleMono ? 500 : 600}
              mono={titleMono}
              numberOfLines={titleLines}
              style={{ flexShrink: 1 }}
            >
              {title}
            </Text>
            <Text size={12.5} mono color={theme.colors.mut} numberOfLines={1}>
              {titleAfter}
            </Text>
          </View>
        ) : (
          <Text
            size={titleMono ? 14.5 : 15}
            weight={titleMono ? 500 : 600}
            mono={titleMono}
            numberOfLines={titleLines}
          >
            {title}
          </Text>
        )}
        {line ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {line}
          </Text>
        ) : null}
        {meta ? (
          <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
            {meta}
          </Text>
        ) : null}
        {badge ? <View style={{ marginTop: 4 }}>{badge}</View> : null}
      </View>
      {trailing ? <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>{trailing}</View> : null}
      {chevron ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ChevronRight size={18} color={theme.colors.mut} strokeWidth={1.7} />
        </View>
      ) : null}
    </>
  );
  const style = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    minHeight: 52,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: theme.colors.line,
    ...(selected ? { backgroundColor: theme.colors.sel } : null),
  };
  if (!onPress)
    return (
      <View style={style} accessible accessibilityLabel={label}>
        {content}
      </View>
    );
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={selected ? { selected } : undefined}
      style={style}
    >
      {content}
    </Touchable>
  );
}

export type BigButtonVariant = 'primary' | 'secondary' | 'quiet';

/**
 * The sheet's buttons (mock 4 right `.big .btn`): 52dp, radius 12, 16/600; `primary` filled (`btn`), `secondary`
 * outlined (`line2`), `quiet` without a border in `mut` (“Not now”).
 */
export function BigButton({
  label,
  variant,
  onPress,
  busy = false,
  disabled = false,
  hint,
}: {
  label: string;
  variant: BigButtonVariant;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  const theme = useTheme();
  // Large text wraps a label rather than cutting it.
  const large = useLargeText();
  const primary = variant === 'primary';
  const color = primary ? theme.colors.btnfg : variant === 'quiet' ? theme.colors.mut : theme.colors.ink;
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled || busy}
      feedback={primary ? 'fade' : 'wash'}
      ringRadius={12}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={{
        minHeight: 52,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
        backgroundColor: primary ? theme.colors.btn : 'transparent',
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: theme.colors.line2,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text
          size={16}
          weight={600}
          color={color}
          numberOfLines={large ? undefined : 1}
          style={large ? { textAlign: 'center', paddingVertical: 8 } : undefined}
        >
          {label}
        </Text>
      )}
    </Touchable>
  );
}
