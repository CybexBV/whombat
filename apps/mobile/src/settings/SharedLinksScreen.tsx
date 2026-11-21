/**
 * Settings → You → Shared links on the phone (Whombat docs/decisions/share-links.md): every link, newest first, with how
 * long it works and how often it was opened; Share, Copy and Stop sharing on the ones that work, and Stop all links.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SHARE_TEXT, shareLinkLine } from '@whombat/client';
import { shareErrorText, useShares, useStopAllShares, useStopShare } from '@whombat/client/react';
import type { SharedLink } from '@whombat/core';
import { Alert, ScrollView, Share, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { Card, Note, Row } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { copyToClipboard } from '../ui/clipboard';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';

type Props = NativeStackScreenProps<RootStackParamList, 'SharedLinks'>;

export function SharedLinksScreen({ navigation }: Props) {
  const { slug, timeZone } = useBurrowBase();
  const bottomRoom = useBottomRoom();
  const list = useShares({ params: { burrow: slug } });
  const stop = useStopShare(slug);
  const stopAll = useStopAllShares(slug);
  const back = <BackBar label="Back" onPress={() => navigation.goBack()} />;
  const failed = (e: unknown) => Alert.alert(shareErrorText(e, SHARE_TEXT.failed));
  if (list.isError)
    return (
      <Screen>
        {back}
        <ErrorState
          text={shareErrorText(list.error, SHARE_TEXT.failed)}
          onRetry={() => void list.refetch()}
        />
      </Screen>
    );
  if (!list.data)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const links = list.data.shares;
  const live = links.filter((l) => l.state === 'live');
  const menu = (l: SharedLink) =>
    Alert.alert(l.title, shareLinkLine(l, timeZone), [
      { text: 'Share link', onPress: () => void Share.share({ message: l.url, url: l.url }) },
      { text: SHARE_TEXT.copy, onPress: () => void copyToClipboard(l.url, SHARE_TEXT.copied) },
      { text: SHARE_TEXT.stop, style: 'destructive', onPress: () => stop.mutate(l.id, { onError: failed }) },
      { text: SHARE_TEXT.cancel, style: 'cancel' },
    ]);
  return (
    <Screen>
      {back}
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={SHARE_TEXT.settingsTitle} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          <Note text={SHARE_TEXT.settingsNote} />
          <Card>
            {links.length === 0 ? (
              <Row first title={SHARE_TEXT.settingsEmpty} />
            ) : (
              links.map((l, i) => (
                <Row
                  key={l.id}
                  first={i === 0}
                  title={l.title}
                  body={shareLinkLine(l, timeZone)}
                  muted={l.state !== 'live'}
                  action={
                    l.state === 'live' ? (
                      <Button
                        label="Manage"
                        variant="secondary"
                        accessibilityLabel={`Manage the link to ${l.title}`}
                        onPress={() => menu(l)}
                      />
                    ) : null
                  }
                />
              ))
            )}
          </Card>
          {live.length > 1 ? (
            <Button
              label={stopAll.isPending ? SHARE_TEXT.stopping : SHARE_TEXT.stopAll}
              variant="secondary"
              disabled={stopAll.isPending}
              onPress={() =>
                Alert.alert(`Stop all ${live.length} links?`, 'Nobody can open them any more.', [
                  { text: SHARE_TEXT.cancel, style: 'cancel' },
                  {
                    text: SHARE_TEXT.stopAll,
                    style: 'destructive',
                    onPress: () => stopAll.mutate(undefined, { onError: failed }),
                  },
                ])
              }
            />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
