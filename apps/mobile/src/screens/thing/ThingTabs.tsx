/**
 * A thing page's tabs (Whombat connection-pages.md CP-19; connection-pages-mobile.md AP-1952; underline-tabs-android.md
 * AP-2634): `UnderlineTabs`, each tab with its count after it (“Integrations 171”), scrolling sideways to the screen's
 * edges when there are more than fit a phone. Connection (its own settings, SST-06) opens the Connection screen (an
 * account's own screen), so it is no tab: a button with a chevron on the right, outside the scrolling tabs, 44dp tall.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import type { PhoneThingTab } from '../../data/thingPage';
import { thingPageCopy } from '../../data/thingPage';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ChevronRight } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import { UnderlineTabs } from '../../ui/UnderlineTabs';

export function ThingTabs({
  tabs,
  value,
  onChange,
  onSettings,
  label,
  inset,
}: {
  tabs: readonly PhoneThingTab[];
  value: string;
  onChange: (key: string) => void;
  onSettings: () => void;
  label: string;
  /** The screen's side padding: the tabs' hairline runs to the screen's edges. */
  inset: number;
}) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const theme = useTheme();
  const shown = useMemo(() => tabs.filter((t) => !t.settings), [tabs]);
  const settings = tabs.find((t) => t.settings);
  return (
    <UnderlineTabs
      tabs={shown}
      value={value}
      onChange={onChange}
      label={label}
      bleed={inset}
      trailing={
        settings ? (
          <Touchable
            accessibilityLabel={settings.spoken}
            accessibilityHint={thingPageCopyHere.settingsHint}
            onPress={onSettings}
            feedback="wash"
            style={{ minHeight: 44, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 4 }}
          >
            <Text size={14.5} weight={500} color={theme.colors.mut} numberOfLines={1}>
              {settings.label}
            </Text>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <ChevronRight size={14} color={theme.colors.mut} strokeWidth={1.8} />
            </View>
          </Touchable>
        ) : null
      }
    />
  );
}
