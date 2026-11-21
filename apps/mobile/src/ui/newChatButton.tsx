/**
 * Chat's and Feedback's New chat button (docs/app/decisions/chat-inbox-phone.md AP-9380): the lists have no message
 * box, so this is the way to a new thread.
 */
import { View } from 'react-native';
import { useTheme } from '../theme/theme';
import { SquarePen } from './icons';
import { Touchable } from './Touchable';

/** The New chat button: a circle this wide, this far from the list's right and bottom edges. */
export const NEW_CHAT_BUTTON = 56;
export const NEW_CHAT_BUTTON_EDGE = 16;

/**
 * Chat's and Feedback's way to a new thread: one round button with the pen, floating over the list's lower right
 * corner, `bottom` above the screen's edge. The list has no box of its own; the button opens the new chat, where the
 * person writes. `selected` while the new chat is what the right page shows (two pages), as the list marks what is
 * open there.
 */
export function NewChatButton({
  label,
  selected = false,
  bottom,
  onPress,
}: {
  label: string;
  selected?: boolean;
  bottom: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ position: 'absolute', right: NEW_CHAT_BUTTON_EDGE, bottom }}>
      <Touchable
        onPress={onPress}
        feedback="fade"
        ringRadius={NEW_CHAT_BUTTON / 2}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        style={{
          width: NEW_CHAT_BUTTON,
          height: NEW_CHAT_BUTTON,
          borderRadius: NEW_CHAT_BUTTON / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.btn,
          boxShadow: theme.shadows.toast.boxShadow,
        }}
      >
        <SquarePen size={24} color={theme.colors.btnfg} strokeWidth={2} />
      </Touchable>
    </View>
  );
}
