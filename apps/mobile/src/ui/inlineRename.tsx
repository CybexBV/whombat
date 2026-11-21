/**
 * A name edited where it is shown (a server's or connection's row held → Rename, a server page's ⋯ → Rename), as the
 * web's `InlineRename`: the name becomes a box in its own face with all of it selected and the keyboard up. Done on the
 * keyboard or leaving the box saves; Cancel under it puts the name back. Why a name can't be used shows under the box
 * in `bad`, and the box stays until the name is changed, Cancel, or leaving it again.
 */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, type StyleProp, TextInput, View, type ViewStyle } from 'react-native';
import { RENAME_COPY } from '../data/rename';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { type FontWeight, textMetrics } from '../theme/type';
import { Touchable } from './Touchable';

export function InlineRename({
  value,
  maxLength,
  label,
  hint,
  onSave,
  onClose,
  size,
  weight = 400,
  mono = false,
  style,
}: {
  /** The name it goes by now: what the box starts with, all selected. */
  value: string;
  maxLength: number;
  /** “Rename pve-02”. */
  label: string;
  /** What an empty box does (“Leave it empty to use its id again.”). */
  hint?: string;
  /** Resolves to why the name didn't go (the box stays), or null when it went or nothing changed. */
  onSave: (typed: string) => Promise<string | null>;
  /** The box closes: saved or cancelled. */
  onClose: () => void;
  /** The face of the text it replaces. */
  size: number;
  weight?: FontWeight;
  mono?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const input = useRef<TextInput>(null);
  const [typed, setTyped] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  // Refs, not state: a blur arrives in the same moment as Done or Cancel and must see them.
  const saving = useRef(false);
  const done = useRef(false);
  // Cancel held: the blur its tap may bring neither saves nor closes.
  const cancelling = useRef(false);
  const metrics = textMetrics({ size, weight, family: mono ? 'mono' : 'sans', lineHeight: 1.25 });

  // Selected once it has focus (selectTextOnFocus alone loses it to the keyboard opening on Android), and focused again
  // when a menu's sheet that was still closing kept autoFocus from taking.
  useEffect(() => {
    const select = () => input.current?.setSelection?.(0, value.length);
    const first = setTimeout(select, 50);
    const again = setTimeout(() => {
      if (input.current && !done.current && !saving.current && !input.current.isFocused()) {
        input.current.focus();
        select();
      }
    }, 400);
    return () => {
      clearTimeout(first);
      clearTimeout(again);
    };
  }, [value]);

  const close = () => {
    if (done.current) return;
    done.current = true;
    onClose();
  };

  const save = async () => {
    if (done.current || saving.current) return;
    saving.current = true;
    const why = await onSave(typed).catch(() => RENAME_COPY.failed);
    saving.current = false;
    if (why) {
      setProblem(why);
      AccessibilityInfo.announceForAccessibility(why);
      input.current?.focus();
      return;
    }
    close();
  };

  return (
    <View style={[{ flex: 1, minWidth: 0, gap: 2 }, style]}>
      <TextInput
        ref={input}
        value={typed}
        onChangeText={(text) => {
          setTyped(text);
          setProblem(null);
        }}
        maxLength={maxLength}
        autoFocus
        selectTextOnFocus
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={() => void save()}
        // Leaving the box saves; leaving it again after a refusal puts the name back as it was.
        onBlur={() => {
          if (saving.current || cancelling.current) return;
          if (problem) close();
          else void save();
        }}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        accessibilityLabel={label}
        accessibilityHint={problem ?? hint}
        selectionColor={theme.colors.brand}
        cursorColor={theme.colors.ink}
        style={{
          minHeight: 44,
          paddingVertical: 6,
          paddingHorizontal: 8,
          marginHorizontal: -9,
          borderRadius: 8,
          borderWidth: 1.5,
          borderColor: problem ? theme.colors.bad : theme.colors.brand,
          backgroundColor: theme.colors.sf,
          color: theme.colors.ink,
          fontFamily: metrics.fontFamily,
          fontSize: metrics.fontSize,
          ...(metrics.letterSpacing ? { letterSpacing: metrics.letterSpacing } : null),
          includeFontPadding: false,
          textAlignVertical: 'center',
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          size={12.5}
          lh={1.35}
          color={problem ? theme.colors.bad : theme.colors.mut}
          accessibilityLiveRegion={problem ? 'polite' : 'none'}
          style={{ flex: 1, minWidth: 0 }}
        >
          {problem ?? hint ?? ''}
        </Text>
        <Touchable
          // Before the box loses focus to the tap, so it doesn't save on the way out.
          onPressIn={() => {
            cancelling.current = true;
          }}
          onPressOut={() => {
            setTimeout(() => {
              cancelling.current = false;
            }, 0);
          }}
          onPress={close}
          feedback="fade"
          ringRadius={8}
          accessibilityLabel={RENAME_COPY.cancel}
          hitSlop={4}
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}
        >
          <Text size={13.5} weight={500} color={theme.colors.brand}>
            {RENAME_COPY.cancel}
          </Text>
        </Touchable>
      </View>
    </View>
  );
}
