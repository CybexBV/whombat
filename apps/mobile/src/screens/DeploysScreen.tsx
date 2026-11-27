/**
 * Deploys on Android (work-removal-android.md AP-858; was Work's second segment, mobile-parity.md MQ-07): what is live
 * where and every recorded deploy (`DeploysPanel`), with pull to refresh. Opened from a deploy card's “Deploys” and a
 * `deploys` link. On a Whombat that doesn't record deploys (`deployments`) nothing leads here; a saved place or a web
 * address that still does opens Connections instead (one-layout-android.md AP-2640).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RefreshControl, ScrollView, View } from 'react-native';
import { OVERVIEW_TITLE } from '../data/shell';
import { useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { useBottomRoom } from '../ui/screenBottom';
import { DeploysPanel, useDeploys } from './DeploysPanel';

type Props = NativeStackScreenProps<RootStackParamList, 'Deploys'>;

export function DeploysScreen({ route, navigation }: Props) {
  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const back = route.params?.back ?? OVERVIEW_TITLE;
  const deploys = useDeploys();
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 20 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={deploys.environments.isRefetching}
            onRefresh={deploys.refetch}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <LargeTitle title={tMobile('screens.deploys')} />
        <View style={{ height: 10 }} />
        <DeploysPanel deploys={deploys} />
      </ScrollView>
    </Screen>
  );
}
