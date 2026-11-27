/**
 * Sharing a thread of Chat by link on the phone (Whombat docs/decisions/share-links.md): the web's Share sheet as a
 * screen — what the link shows, Include pictures, how long it works, what to look at first, Create link; then the link
 * with Share link (the system's share sheet) and Copy link. Opened from a Chat thread's header (the whole thread) or a
 * message's menu (from that message on).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  shareContents,
  shareExpiryOptions,
  shareReadyLine,
  shareText,
  shareWarningText,
} from '@whombat/client';
import { shareErrorText, useCreateShare, useSharePreview } from '@whombat/client/react';
import type { SharedLink } from '@whombat/core';
import { SHARE_DEFAULT_EXPIRY, type ShareExpiry } from '@whombat/core/share';
import { useMemo, useState } from 'react';
import { ScrollView, Share, Switch, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n, useMobileT } from '../i18n';
import { Card, Note, Row } from '../managed/ui';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useBottomRoom } from '../ui/screenBottom';
import { switchColors } from '../ui/switchColors';

type Props = NativeStackScreenProps<RootStackParamList, 'ShareLink'>;

export function ShareLinkScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const shareTextHere = shareText(rawLocale);
  const shareExpiryOptionsHere = shareExpiryOptions(rawLocale);
  const { t: tMobile } = useMobileT();
  const { slug, timeZone } = useBurrowBase();
  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const { rootId, fromMessageId } = route.params;
  const scope = useMemo(
    () => ({ rootId, ...(fromMessageId ? { fromMessageId } : {}) }),
    [rootId, fromMessageId],
  );
  const preview = useSharePreview(slug, scope);
  const create = useCreateShare(slug);
  const [pictures, setPictures] = useState(true);
  const [expiry, setExpiry] = useState<ShareExpiry>(SHARE_DEFAULT_EXPIRY);
  const [made, setMade] = useState<SharedLink | null>(null);
  const back = <BackBar label={tMobile('managed.back')} onPress={() => navigation.goBack()} />;
  const p = preview.data;
  if (preview.isError)
    return (
      <Screen>
        {back}
        <ErrorState
          text={shareErrorText(preview.error, shareTextHere.failed)}
          onRetry={() => void preview.refetch()}
        />
      </Screen>
    );
  if (!p)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const fitsWithPictures = p.fits.withPictures;
  const keepPictures = pictures && fitsWithPictures && p.pictures > 0;
  const canCreate = p.messages > 0 && (keepPictures ? p.fits.withPictures : p.fits.withoutPictures);
  const title = made
    ? shareTextHere.readyTitle
    : fromMessageId
      ? shareTextHere.fromHere
      : shareTextHere.title;
  return (
    <Screen>
      {back}
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={title} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          {made ? (
            <>
              <Text size={15} lh={1.45} color={theme.colors.ink2}>
                {shareReadyLine(made, timeZone, rawLocale)}
              </Text>
              <Card>
                <Row first title={made.title} meta={made.url} />
              </Card>
              <View style={{ gap: 10 }}>
                <Button
                  label={tMobile('screens.share-link')}
                  size="lg"
                  onPress={() => void Share.share({ message: made.url, url: made.url })}
                />
                <Button
                  label={shareTextHere.copy}
                  variant="secondary"
                  size="lg"
                  onPress={() => void copyToClipboard(made.url, shareTextHere.copied, rawLocale)}
                />
              </View>
              <Note text={shareTextHere.frozen} />
            </>
          ) : (
            <>
              <Text size={15} lh={1.45} color={theme.colors.ink2}>
                {`“${p.title}” · ${shareContents(p, keepPictures, rawLocale)}`}
              </Text>
              {p.pictures > 0 ? (
                <Card>
                  <Row
                    first
                    title={shareTextHere.pictures}
                    body={fitsWithPictures ? null : shareTextHere.noPicturesFit}
                    action={
                      <Switch
                        value={keepPictures}
                        disabled={!fitsWithPictures}
                        onValueChange={setPictures}
                        accessibilityLabel={shareTextHere.pictures}
                        {...switchColors(theme, keepPictures)}
                      />
                    }
                  />
                </Card>
              ) : null}
              <View style={{ gap: 8 }}>
                <Text size={13} weight={500} color={theme.colors.mut}>
                  {shareTextHere.expiry}
                </Text>
                <Segmented
                  label={shareTextHere.expiry}
                  options={shareExpiryOptionsHere}
                  value={expiry}
                  onChange={setExpiry}
                />
              </View>
              {p.warnings.length > 0 ? (
                <Card label={shareTextHere.lookFirst}>
                  {p.warnings.map((w, i) => (
                    <Row key={w.kind} first={i === 0} title={shareWarningText(w, rawLocale)} />
                  ))}
                </Card>
              ) : null}
              {!p.fits.withoutPictures ? (
                <Text size={14} color={theme.colors.bad}>
                  {shareTextHere.tooBig}
                </Text>
              ) : null}
              <Note
                text={`${shareTextHere.privacy}${p.leftOut > 0 ? ` ${shareTextHere.leftOutNote(p.leftOut)}` : ''}`}
              />
              {create.isError ? (
                <Text size={14} color={theme.colors.bad} accessibilityLiveRegion="polite">
                  {shareErrorText(create.error, shareTextHere.failed)}
                </Text>
              ) : null}
              <Button
                label={create.isPending ? shareTextHere.creating : shareTextHere.create}
                size="lg"
                disabled={!canCreate || create.isPending}
                busy={create.isPending}
                onPress={() =>
                  create.mutate({ ...scope, pictures: keepPictures, expiry }, { onSuccess: setMade })
                }
              />
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
