/**
 * One backup on the phone (Whombat backup-options.md BKO-06, BKO-07; backup-options-android.md AP-6856; app
 * backup-v2.md): ‹ Backups, the day and time, why it was made and what it added on which place, the last check's badge,
 * WHAT’S IN IT from its own coverage (what comes back, what it left out, what a new Whombat sets up again), “Check this
 * backup now” (`backup.check`; the result lands on the backup) and, below it, “Bring things back from this backup”.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  BACKUP_LOOK_TEXT,
  BACKUP_OPTIONS_TEXT,
  backupContents,
  backupLabel,
  relativeDay,
} from '@whombat/client/managed';
import { useBackupCheckpoints, useCheckBackup } from '@whombat/client/react';
import { formatBytes } from '@whombat/core/text';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useI18n } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
import { BackBar, Screen } from '../ui/headers';
import { Button, ErrorState, Loading, SectionLabel } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { backupErrorText } from './BackupDestination';
import { backupTitle } from './backupOptions';
import { managedText } from './copy';
import { ErrorLine, Note } from './ui';
import { useBackupPlaceName, useBackupSession } from './useBackups';

type Props = NativeStackScreenProps<RootStackParamList, 'BackupDetail'>;

const T = BACKUP_OPTIONS_TEXT.detail;

export function BackupDetailScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const managedTextHere = managedText(rawLocale);

  const theme = useTheme();
  const bottomRoom = useBottomRoom();
  const session = useBackupSession();
  const list = useBackupCheckpoints(session);
  const placeName = useBackupPlaceName(session);
  const check = useCheckBackup(session);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = (
    <BackBar
      label={T.back}
      onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatBackups'))}
    />
  );
  if (!session || list.isError)
    return (
      <Screen>
        {back}
        <ErrorState text={managedTextHere.loadError} onRetry={() => void list.refetch()} />
      </Screen>
    );
  if (!list.data)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const own = list.data.checkpoints.filter((c) => c.own);
  const cp = list.data.checkpoints.find((c) => c.id === route.params.checkpointId);
  if (!cp)
    return (
      <Screen>
        {back}
        <ErrorState text={BACKUP_OPTIONS_TEXT.list.empty} />
      </Screen>
    );
  const isFirst = cp.own && own.at(-1)?.id === cp.id;
  const added = cp.bytesAdded === null ? null : formatBytes(cp.bytesAdded, rawLocale);
  const reason = backupLabel(cp, isFirst);
  const checkDay = cp.check ? relativeDay(cp.check.at) : null;

  return (
    <Screen>
      {back}
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 + bottomRoom, gap: 10 }}>
        <View style={{ paddingHorizontal: 6, gap: 6 }}>
          <Text size={28} weight={700} tracking={-0.02} lh={1.2} accessibilityRole="header">
            {backupTitle(cp.createdAt)}
          </Text>
          <Text size={14.5} color={theme.colors.ink2}>
            {T.meta(reason, added, placeName)}
          </Text>
          {cp.check && checkDay ? (
            <View
              style={{
                alignSelf: 'flex-start',
                marginTop: 4,
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
                backgroundColor: tint(cp.check.ok ? theme.colors.ok : theme.colors.bad, 0.14),
              }}
            >
              <Text size={13} weight={500} color={cp.check.ok ? theme.colors.ok : theme.colors.bad}>
                {cp.check.ok ? `✓ ${T.checked(checkDay)}` : T.checkFailed(checkDay)}
              </Text>
            </View>
          ) : null}
        </View>

        <View>
          <SectionLabel>{T.inIt.toUpperCase()}</SectionLabel>
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.sf,
              overflow: 'hidden',
            }}
          >
            {backupContents(cp).map((item, i) => (
              <View
                key={item.key}
                accessible
                accessibilityLabel={`${item.covered ? T.lines.included : T.lines.notIncluded}: ${item.text}${item.note ? `. ${item.note}` : ''}`}
                style={{
                  flexDirection: 'row',
                  gap: 12,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text
                  size={15}
                  color={item.gap ? theme.colors.warn : item.covered ? theme.colors.ok : theme.colors.mut}
                  style={{ width: 16 }}
                >
                  {item.gap ? '!' : item.covered ? '✓' : '–'}
                </Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text size={15} lh={1.4} color={item.covered ? theme.colors.ink : theme.colors.mut}>
                    {item.text}
                  </Text>
                  {item.note ? (
                    <Text size={12.5} color={theme.colors.mut}>
                      {item.note}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </View>

        <Button
          label={check.isPending ? T.checking : T.checkNow}
          variant="secondary"
          size="lg"
          busy={check.isPending}
          disabled={queued}
          onPress={() => {
            setError(null);
            check.mutate(cp.id, {
              onSuccess: () => setQueued(true),
              onError: (e) => setError(backupErrorText(e)),
            });
          }}
        />
        {queued ? <Note text={T.checkQueued} /> : null}
        <ErrorLine text={error} />
        {/* Getting one thing back from this backup (backup-look.md): its own screen. */}
        <Button
          label={BACKUP_LOOK_TEXT.entry}
          size="lg"
          onPress={() =>
            navigation.navigate('BackupBringBack', { checkpointId: cp.id, createdAt: cp.createdAt })
          }
        />
      </ScrollView>
    </Screen>
  );
}
