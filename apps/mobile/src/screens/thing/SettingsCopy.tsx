/**
 * A service's settings copy on its screen (Whombat outside-changes.md; `ThingPage.settingsCopy`, session minor 22): when
 * the newest copy was made, what it holds or why the last try didn't work, and Download, which writes the file to the
 * app's cache and opens the share sheet (Files, mail, a computer), as the phone shares its other files. Restoring a copy
 * is the service's own.
 */
import { settingsCopyWords } from '@whombat/client';
import { useSettingsCopyDownload } from '@whombat/client/react';
import type { SettingsCopyView } from '@whombat/core';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { FoldRow } from './Panels';

export function SettingsCopyCard({ thing, copy }: { thing: string; copy: SettingsCopyView }) {
  const { rawLocale } = useI18n();
  const words = settingsCopyWords(rawLocale);
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const { supported, busy, failed, download } = useSettingsCopyDownload(slug, thing);
  const [shareFailed, setShareFailed] = useState(false);
  const copyId = copy.copyId;
  const save = async () => {
    setShareFailed(false);
    const got = await download(copyId);
    if (!got) return;
    const file = new File(Paths.cache, got.fileName);
    try {
      if (file.exists) file.delete();
      file.create();
      file.write(got.bytes);
      await Sharing.shareAsync(file.uri, { mimeType: got.contentType, dialogTitle: got.fileName });
    } catch {
      setShareFailed(true);
    }
  };
  return (
    <OneCard label={copy.title} meta={copy.kept > 1 ? words.kept(copy.kept) : null}>
      {copy.detail ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <Text size={14} lh={1.45} color={copy.failing ? theme.colors.ink : theme.colors.mut}>
            {copy.detail}
          </Text>
          {failed || shareFailed ? (
            <Text size={13} color={theme.colors.bad} accessibilityRole="alert">
              {words.failed}
            </Text>
          ) : null}
        </View>
      ) : null}
      {supported && copyId && copy.fileName ? (
        <FoldRow
          label={busy ? words.downloading : words.download}
          onPress={() => void (busy ? undefined : save())}
        />
      ) : null}
    </OneCard>
  );
}
