/**
 * The back chevron on iPhone: iOS's own SF Symbol `chevron.backward` (it turns round in a right-to-left language), drawn
 * by SwiftUI through `@expo/ui` in the back button's `brand`, semibold like a navigation bar's. Decorative: the button
 * around it says where it goes.
 */
import { Host, Image } from '@expo/ui/swift-ui';
import { accessibilityHidden, font } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme/theme';

export function BackGlyph() {
  const theme = useTheme();
  return (
    <Host matchContents colorScheme={theme.name} pointerEvents="none">
      <Image
        systemName="chevron.backward"
        color={theme.colors.brand}
        modifiers={[font({ size: 20, weight: 'semibold' }), accessibilityHidden(true)]}
      />
    </Host>
  );
}
