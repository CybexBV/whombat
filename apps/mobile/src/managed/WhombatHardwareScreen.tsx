/**
 * This Whombat → About → Hardware (managed only): the machine and every part with its driver, and Share report. About
 * shows only one row for it, so the list of parts doesn't fill that page; NETWORK's and BLUETOOTH's See hardware open
 * this screen directly.
 */

import { type RouteProp, useRoute } from '@react-navigation/native';
import { THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import { ScrollView, View } from 'react-native';
import { useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { useBottomRoom } from '../ui/screenBottom';
import { HardwareSection } from './HardwareSection';
import { MACHINE_TEXT } from './machine';
import { useApplianceStatus } from './useApplianceStatus';
import { useMachineHere } from './useMachine';

export function WhombatHardwareScreen() {
  const bottomRoom = useBottomRoom();
  const navigation = useAppNavigation();
  const machine = useMachineHere();
  // The way back is named after where it came from: About, or This Whombat (See hardware).
  const back = useRoute<RouteProp<RootStackParamList, 'WhombatHardware'>>().params?.back;
  // The Whombat's version for the report's header, when its status was read.
  const { status } = useApplianceStatus();
  return (
    <Screen>
      <BackBar
        label={back ?? THIS_WHOMBAT_TEXT.parts.about}
        onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatAbout'))}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={MACHINE_TEXT.hardware} />
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <HardwareSection machine={machine} runtime={status?.appliance.runtimeVersion ?? null} />
        </View>
      </ScrollView>
    </Screen>
  );
}
