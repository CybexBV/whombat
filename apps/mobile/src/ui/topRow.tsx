/**
 * A tab's top row (app chat-inbox-phone.md): one row of 52 under the status bar with Places as its ☰ at the left, the
 * tab's title (24/700), what the tab keeps beside its title, and Search as its magnifier at the right. Both icons are
 * 44pt targets (48dp on Android) with the words they had as their names. Pages pushed over the tabs have no such row:
 * ‹ Back comes first, with Places at the right where the page has room.
 */
import { type ReactNode, useContext } from 'react';
import { View } from 'react-native';
import { placeOfScreen } from '../data/places';
import { tabWords } from '../data/shell';
import { useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { TabRootContext } from './headers';
import { Search } from './icons';
import { PlacesButton, SHELL_TARGET } from './places';
import { Touchable } from './Touchable';

/** The row's height: the mockup's 52, never under the target. */
export const TAB_TOP_HEIGHT = Math.max(52, SHELL_TARGET);

export function TabTop({
  title,
  right,
  lined = true,
}: {
  title: string;
  /** What the tab shows beside its title (Chat's Feedback). */
  right?: ReactNode;
  /** A hairline under the row; off where the row under it draws its own (Chat's filters). */
  lined?: boolean;
}) {
  const theme = useTheme();
  const navigation = useAppNavigation();
  const tab = useContext(TabRootContext);
  const { rawLocale } = useI18n();
  const { t } = useMobileT();
  const here = tab ? tabWords(rawLocale)[tab] : title;
  return (
    <View
      style={{
        minHeight: TAB_TOP_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingLeft: tab ? 6 : 16,
        paddingRight: 6,
        borderBottomWidth: lined ? 1 : 0,
        borderBottomColor: theme.colors.line,
      }}
    >
      {tab ? <PlacesButton current={placeOfScreen(tab)} here={here} iconOnly /> : null}
      <Text
        size={24}
        weight={700}
        tracking={-0.02}
        numberOfLines={1}
        accessibilityRole="header"
        style={{ flex: 1, minWidth: 56, marginLeft: 2 }}
      >
        {title}
      </Text>
      {right}
      {tab ? (
        <Touchable
          onPress={() => navigation.navigate('Search', { back: here })}
          feedback="wash"
          ringRadius={SHELL_TARGET / 2}
          accessibilityRole="link"
          accessibilityLabel={t('places.search')}
          style={{
            minHeight: SHELL_TARGET,
            minWidth: SHELL_TARGET,
            borderRadius: SHELL_TARGET / 2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Search size={22} color={theme.colors.ink2} strokeWidth={1.75} />
        </Touchable>
      ) : null}
    </View>
  );
}
