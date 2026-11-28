/**
 * A thing by its id (contracts 0.80 `thingId`; one-whombat-mobile.md AP-1363): a server opens its page here; a
 * connection or a device (a device is a connection made from its skill) opens its own page (contracts 0.88
 * `things.page`; connection-pages-mobile.md AP-1950).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { parseThingId } from '@whombat/core';
import { thingPageCopy } from '../data/thingPage';
import { useI18n } from '../i18n';
import { backWordUnder } from '../navigation/backWord';
import type { RootStackParamList } from '../navigation/routes';
import { BackBar, Screen } from '../ui/headers';
import { ErrorState } from '../ui/primitives';
import { ServerScreen } from './ServerScreen';
import { ThingPageScreen } from './ThingPageScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'Thing'>;

export function ThingScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const {
    thingId,
    title,
    back = backWordUnder(navigation.getState(), route.key, rawLocale),
    tab,
  } = route.params;
  const thing = parseThingId(thingId);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  if (thing?.kind === 'server')
    return <ServerScreen serverId={thing.id} name={title ?? thing.id} back={back} onBack={goBack} />;
  if (thing) return <ThingPageScreen thingId={thingId} title={title} back={back} tab={tab} onBack={goBack} />;
  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ErrorState text={thingPageCopyHere.notFound} />
    </Screen>
  );
}
