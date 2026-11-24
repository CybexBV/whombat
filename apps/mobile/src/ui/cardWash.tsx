/**
 * A card's soft light from its top left corner in a tone (the arranged Overview's summary card, the mock's
 * `.pulse::before`): a radial wash at 14 % fading out by the middle. Decorative and behind the card's content, so it
 * is no part of what a screen reader reads.
 */
import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

export function CardWash({ color, strength = 0.14 }: { color: string; strength?: number }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient
            id="wash"
            cx="0%"
            cy="0%"
            rx="120%"
            ry="140%"
            fx="0%"
            fy="0%"
            gradientUnits="objectBoundingBox"
          >
            <Stop offset="0" stopColor={color} stopOpacity={strength} />
            <Stop offset="0.55" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#wash)" />
      </Svg>
    </View>
  );
}
