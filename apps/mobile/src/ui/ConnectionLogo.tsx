/**
 * A connection's logo tile (connections-catalog.md CX-70, CX-74): a square with a hairline border on the surface
 * colour and the provider's mark inside (`@whombat/brand`, its own colours; black marks follow the text), our icon for
 * the Custom entries and Website feedback, else the name's first letter. Decorative: the name is always beside it.
 */
import { WORDMARKS } from '@whombat/brand';
import { View } from 'react-native';
import type { ConnectionLogoKind } from '../data/connections';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { type LucideIcon, MessageSquare, Plug, Server } from './icons';

const ICONS: Record<'plug' | 'message' | 'server', LucideIcon> = {
  plug: Plug,
  message: MessageSquare,
  server: Server,
};

export function ConnectionLogo({ logo, size = 40 }: { logo: ConnectionLogoKind; size?: number }) {
  const theme = useTheme();
  // A wordmark (Synology's, QNAP's; AP-3800) goes across the tile, a symbol in its middle half.
  const inner = logo.kind === 'mark' && WORDMARKS.has(logo.mark) ? size - 8 : Math.round(size / 2);
  const Icon = logo.kind === 'icon' ? ICONS[logo.icon] : null;
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
        backgroundColor: theme.colors.sf,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {logo.kind === 'mark' ? (
        <BrandMark mark={logo.mark} size={inner} />
      ) : Icon ? (
        <Icon size={inner} color={theme.colors.ink2} strokeWidth={1.75} />
      ) : logo.kind === 'monogram' ? (
        <Text size={Math.round(size * 0.45)} weight={600} color={theme.colors.ink2}>
          {logo.letter}
        </Text>
      ) : null}
    </View>
  );
}
