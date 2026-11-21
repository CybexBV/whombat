/**
 * The council's faces, small: its elders' heads (`@whombat/avatars` `elderSvg`, one per seat) in overlapping rounds, as
 * the council's room draws them at its table. Beside “What the council decided”, a point's council advice and T3 Code's
 * line while the council reviews. Decoration only: the words beside them say it is the council.
 */
import { ELDER_VIEWBOX, elderSvg } from '@whombat/avatars';
import { useId, useMemo } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '../theme/theme';

/** How far the drawing reaches past the head on each side: its head spans about 87% of its width, from the top. */
const HEAD_SHARE = 0.87;

export function CouncilFaces({
  size = 22,
  count = 3,
  overlap = 5,
  ring,
}: {
  size?: number;
  count?: number;
  /** How far each face sits over the one before it. */
  overlap?: number;
  /** The ring between the faces: the surface they sit on (the page's by default). */
  ring?: string;
}) {
  const theme = useTheme();
  const id = useId();
  const width = Math.round(size / HEAD_SHARE);
  const height = Math.round((width * ELDER_VIEWBOX.height) / ELDER_VIEWBOX.width);
  const faces = useMemo(
    () =>
      Array.from({ length: count }, (_, seat) =>
        elderSvg({ seat, pose: 'waiting', idPrefix: `faces${id}${seat}` }),
      ),
    [count, id],
  );
  return (
    <View
      style={{ flexDirection: 'row' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {faces.map((xml, seat) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the seats never reorder
          key={seat}
          style={{
            width: size + 4,
            height: size + 4,
            marginLeft: seat === 0 ? 0 : -overlap,
            borderRadius: (size + 4) / 2,
            borderWidth: 2,
            borderColor: ring ?? theme.colors.bg,
            backgroundColor: theme.colors.sf2,
            overflow: 'hidden',
          }}
        >
          <View style={{ position: 'absolute', top: -1, left: (size - width) / 2 }}>
            <SvgXml xml={xml} width={width} height={height} color={theme.colors.ink2} />
          </View>
        </View>
      ))}
    </View>
  );
}
