/**
 * The right page while nothing is open there (docs/app/decisions/iphone-duo.md): beside Chat a new chat, elsewhere one
 * quiet line saying what to pick in the list, so the page doesn't look broken.
 */
import { View } from 'react-native';
import type { Tab } from '../data/shell';
import { mobileTranslator, useI18n } from '../i18n';
import { NewChatPage } from '../screens/ChatRoomScreen';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Screen } from '../ui/headers';

export function emptyPageWords(locale?: string): Record<Exclude<Tab, 'ChatRoom'>, string> {
  const { t } = mobileTranslator(locale);
  return {
    NeedsYou: t('data.emptyPage.needsYou'),
    Dashboard: t('data.emptyPage.dashboard'),
    Automations: t('data.emptyPage.automations'),
    Settings: t('data.emptyPage.settings'),
  };
}
export const EMPTY_PAGE_WORDS = emptyPageWords();

export function EmptyPage({ tab }: { tab: Tab }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  if (tab === 'ChatRoom') return <NewChatPage />;
  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Text size={15} color={theme.colors.mut} style={{ textAlign: 'center' }}>
          {emptyPageWords(rawLocale)[tab]}
        </Text>
      </View>
    </Screen>
  );
}
