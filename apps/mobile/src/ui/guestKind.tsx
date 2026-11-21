/**
 * A guest's kind as a mark (less-is-more.md AP-1755; AP-1810): Docker's for a Docker container, the Linux Containers
 * mark for an Incus or a Proxmox container, a screen for any VM. Decorative inside a row whose label says the kind's
 * words (`guestKind(g).label`); with `label` it is read on its own.
 */
import type { GuestKindGlyph } from '@whombat/client/hosts';
import { View } from 'react-native';
import { useTheme } from '../theme/theme';
import { BrandMark } from './BrandMark';
import { Monitor } from './icons';

export function GuestKindMark({
  glyph,
  size = 18,
  label,
}: {
  glyph: GuestKindGlyph;
  size?: number;
  label?: string;
}) {
  const theme = useTheme();
  const a11y = label
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  return (
    <View {...a11y} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {glyph === 'vm' ? (
        <Monitor size={size - 1} color={theme.colors.ink2} strokeWidth={1.8} />
      ) : (
        <BrandMark mark={glyph === 'docker' ? 'docker' : 'linuxcontainers'} size={size} />
      )}
    </View>
  );
}
