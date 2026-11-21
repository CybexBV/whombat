/**
 * “More” under a page's one sentence (less-is-more.md AP-1751, AP-1811): the rest of the help, folded until asked for.
 * A 44dp link-style button in `brand` with a chevron that turns, then the folded paragraphs in `mut`. `open` starts it
 * open (AP-1753: trouble is shown at once).
 */
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronDown, ChevronUp } from './icons';
import { Touchable } from './Touchable';

export function MoreFold({
  label = 'More',
  open: startOpen = false,
  children,
  inset = 0,
  flush = false,
}: {
  label?: string;
  open?: boolean;
  /** Paragraphs (strings) or anything else to show when open. */
  children: ReactNode;
  /** Horizontal padding of the button and the folded part. */
  inset?: number;
  /** The folded part is rows with their own padding and hairlines (a card's keys): no padding, no gaps. */
  flush?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(startOpen);
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <View style={{ gap: 4 }}>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="fade"
        ringRadius={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        style={{
          alignSelf: 'flex-start',
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: inset,
        }}
      >
        <Text size={13.5} weight={600} color={theme.colors.brand}>
          {label}
        </Text>
        <Chevron size={15} color={theme.colors.brand} strokeWidth={2} />
      </Touchable>
      {open ? (
        <View style={flush ? null : { gap: 6, paddingHorizontal: inset, paddingBottom: 4 }}>{children}</View>
      ) : null}
    </View>
  );
}

/** A folded paragraph: 13/1.45 `mut`. */
export function FoldText({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text size={13} lh={1.45} color={theme.colors.mut}>
      {children}
    </Text>
  );
}
