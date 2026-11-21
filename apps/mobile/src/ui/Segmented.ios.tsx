/**
 * The segmented control on iPhone: iOS's own, drawn by SwiftUI through `@expo/ui`. Its segmented control where every
 * label fits a share of the narrowest iPhone on one line, else its menu picker: the chosen one's words with iOS's ⌃⌄,
 * opening a menu of all of them. Light or dark as the app is, the menu in `brand` as a link is. `lines` and `fit` are
 * for ours (`Segmented.tsx`): iOS's segments don't wrap or size by their words.
 */
import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  controlSize,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme/theme';
import { useHeldPick } from './heldPick';
import { type SegmentedProps, segmentedLook } from './segmentedLook';

/** iOS's menu button keeps this much each side of its words; pulled back by it, they line up with the text around. */
const MENU_INSET = 12;

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: SegmentedProps<T>) {
  const theme = useTheme();
  const { key, pick } = useHeldPick(value, onChange);
  const look = segmentedLook(options);
  const menu = look === 'menu';
  return (
    <Host
      key={look}
      matchContents={menu ? true : { vertical: true }}
      colorScheme={theme.name}
      seedColor={theme.colors.brand}
      style={menu ? { alignSelf: 'flex-start', marginStart: -MENU_INSET } : { alignSelf: 'stretch' }}
    >
      <Picker<T>
        key={key}
        label={label}
        selection={value}
        onSelectionChange={pick}
        modifiers={
          menu
            ? [pickerStyle('menu'), disabledModifier(disabled)]
            : // iOS's large segments, 40pt or so, are nearer the 44pt a finger wants; the group's name for VoiceOver.
              [
                pickerStyle('segmented'),
                controlSize('large'),
                accessibilityLabel(label),
                disabledModifier(disabled),
              ]
        }
      >
        {options.map((o) => (
          <SwiftText key={o.value} modifiers={[tag(o.value)]}>
            {o.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}
