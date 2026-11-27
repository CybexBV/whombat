/**
 * “Moving faces” in Settings → Often used: whether the agents' faces blink and show what they are doing on this phone.
 * Kept on this phone only, like the phone's other choices; with it off (or the system's reduce motion on) a face still
 * changes its look, it just doesn't move.
 */
import { Switch, View } from 'react-native';
import { useFaceMotionSetting } from '../avatars/faceMotionSetting';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Smile } from '../ui/icons';
import { switchColors } from '../ui/switchColors';

export const FACE_MOTION_TEXT = {
  title: 'Moving faces',
  line: 'Faces blink and show what your agents are doing.',
} as const;

export function FaceMotionRow({ first = false }: { first?: boolean }) {
  const theme = useTheme();
  const [on, setOn] = useFaceMotionSetting();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        minHeight: 64,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
        <Smile size={20} color={theme.colors.ink2} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text size={16} weight={600}>
          {FACE_MOTION_TEXT.title}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.ink2}>
          {FACE_MOTION_TEXT.line}
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={setOn}
        accessibilityLabel={FACE_MOTION_TEXT.title}
        accessibilityHint={FACE_MOTION_TEXT.line}
        accessibilityRole="switch"
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
