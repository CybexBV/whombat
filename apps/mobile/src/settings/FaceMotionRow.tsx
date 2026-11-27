/**
 * “Moving faces” in Settings → Often used: whether the agents' faces blink and show what they are doing on this phone.
 * Kept on this phone only, like the phone's other choices; with it off (or the system's reduce motion on) a face still
 * changes its look, it just doesn't move.
 */
import { Switch, View } from 'react-native';
import { useFaceMotionSetting } from '../avatars/faceMotionSetting';
import { useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Smile } from '../ui/icons';
import { switchColors } from '../ui/switchColors';

export function FaceMotionRow({ first = false }: { first?: boolean }) {
  const { t } = useMobileT();
  const title = t('settings.movingFaces.title');
  const line = t('settings.movingFaces.line');
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
          {title}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.ink2}>
          {line}
        </Text>
      </View>
      <Switch
        value={on}
        onValueChange={setOn}
        accessibilityLabel={title}
        accessibilityHint={line}
        accessibilityRole="switch"
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
