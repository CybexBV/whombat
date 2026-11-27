import { useVoice } from '@whombat/client/voice/react';
import { resolveLanguage } from '@whombat/core/i18n';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { MOBILE_LANGUAGES } from '../i18n/locale';
import { useLocaleNeedsUpdate, useSaveLocale } from '../i18n/provider';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { SectionLabel } from '../ui/primitives';
import { RadioCards } from '../ui/radioCards';
import { useVoiceApi } from '../voice/useVoiceApi';

export function LanguageSection() {
  const saveLocale = useSaveLocale();
  const needsUpdate = useLocaleNeedsUpdate();
  const { tClient } = useI18n();
  const { t } = useMobileT();
  const theme = useTheme();
  if (saveLocale) return <LanguagePicker saveLocale={saveLocale} />;
  if (!needsUpdate) return null;
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel>{tClient('settings.language.title')}</SectionLabel>
      <Text size={13} color={theme.colors.mut}>
        {t('language.needsUpdate')}
      </Text>
    </View>
  );
}

function LanguagePicker({ saveLocale }: { saveLocale: (next: string) => Promise<void> }) {
  const { language, tClient } = useI18n();
  const { t } = useMobileT();
  const theme = useTheme();
  const voice = useVoice(useVoiceApi());
  const [busy, setBusy] = useState(false);
  const [pickedDutch, setPickedDutch] = useState(false);
  const title = tClient('settings.language.title');

  const choose = async (next: string) => {
    if (busy || resolveLanguage(next) === language) return;
    setBusy(true);
    try {
      await saveLocale(next);
      setPickedDutch(resolveLanguage(next) === 'nl');
    } catch {
      Alert.alert(title, t('language.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <SectionLabel>{title}</SectionLabel>
      <RadioCards
        label={title}
        options={MOBILE_LANGUAGES}
        value={language === 'nl' ? 'nl-NL' : 'en-GB'}
        onChange={(next) => void choose(next)}
        disabled={busy}
      />
      {pickedDutch && language === 'nl' && voice.data?.available && voice.data.dutchVoice?.on === false ? (
        <Text size={13} color={theme.colors.mut}>
          {t('language.dutchVoiceHint')}
        </Text>
      ) : null}
    </View>
  );
}
