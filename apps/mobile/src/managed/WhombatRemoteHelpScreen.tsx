/**
 * This Whombat → About → Remote help (managed only): turning it on (how much, for how long) or what it is doing now,
 * and what support did, visit by visit. About shows only a short card for it, so a long history doesn't fill that page.
 */

import { remoteHelpWords, thisWhombatText } from '@whombat/client/managed';
import { ScrollView, View } from 'react-native';
import { useI18n } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { useBottomRoom } from '../ui/screenBottom';
import { RemoteHelpSection } from './RemoteHelpSection';
import { useRemoteHelpHere } from './useRemoteHelpHere';

export function WhombatRemoteHelpScreen() {
  const { rawLocale } = useI18n();
  const bottomRoom = useBottomRoom();
  const navigation = useAppNavigation();
  const here = useRemoteHelpHere();
  return (
    <Screen>
      <BackBar
        label={thisWhombatText(rawLocale).parts.about}
        onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatAbout'))}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={remoteHelpWords(rawLocale).title} />
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <RemoteHelpSection here={here} titled={false} />
        </View>
      </ScrollView>
    </Screen>
  );
}
