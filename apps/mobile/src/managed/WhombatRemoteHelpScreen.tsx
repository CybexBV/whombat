/**
 * This Whombat → About → Remote help (managed only): turning it on (how much, for how long) or what it is doing now,
 * and what support did, visit by visit. About shows only a short card for it, so a long history doesn't fill that page.
 */

import { REMOTE_HELP_WORDS, THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import { ScrollView, View } from 'react-native';
import { useAppNavigation } from '../navigation/hooks';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { useBottomRoom } from '../ui/screenBottom';
import { RemoteHelpSection } from './RemoteHelpSection';
import { useRemoteHelpHere } from './useRemoteHelpHere';

export function WhombatRemoteHelpScreen() {
  const bottomRoom = useBottomRoom();
  const navigation = useAppNavigation();
  const here = useRemoteHelpHere();
  return (
    <Screen>
      <BackBar
        label={THIS_WHOMBAT_TEXT.parts.about}
        onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatAbout'))}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={REMOTE_HELP_WORDS.title} />
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <RemoteHelpSection here={here} />
        </View>
      </ScrollView>
    </Screen>
  );
}
