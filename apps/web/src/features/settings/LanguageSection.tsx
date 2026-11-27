/**
 * Settings → You → Profile → LANGUAGE: English or Nederlands for the whole Whombat (the app, the assistant's replies,
 * notifications and emails), saved in the account's preferences (`me.updatePreferences`, `locale`) like the theme. The
 * page changes at once; what the box writes itself comes back in the new language once it has saved it.
 *
 * Switching to Dutch never turns on the Dutch voice: it has a licence of its own the person agrees to in Settings →
 * This Whombat. Where the box offers it and it is off, a quiet note says where to find it.
 */
import { Link } from '@tanstack/react-router';
import { queryKeys } from '@whombat/client/query';
import { useBootstrap } from '@whombat/client/react';
import { useVoice } from '@whombat/client/voice/react';
import type { Bootstrap, Preferences } from '@whombat/core';
import { LANGUAGE_NATIVE_NAMES, type Language, SUPPORTED_LANGUAGES } from '@whombat/core/i18n';
import { useId, useState, useSyncExternalStore } from 'react';
import { useAppServices, useOptionalAppServices } from '../../app/providers';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { storedLocaleOf } from '../../i18n/locale';
import { useWebI18n, useWebLocaleControl } from '../../i18n/provider';
import styles from './SettingsScreen.module.css';

/**
 * Whether the person chose Dutch here since the page opened. Kept outside the component: choosing a language draws the
 * screens again, and the note must still show after that.
 */
let choseDutch = false;
const choseDutchListeners = new Set<() => void>();
function setChoseDutch(next: boolean) {
  choseDutch = next;
  for (const listener of choseDutchListeners) listener();
}
function useChoseDutch(): boolean {
  return useSyncExternalStore(
    (change) => {
      choseDutchListeners.add(change);
      return () => {
        choseDutchListeners.delete(change);
      };
    },
    () => choseDutch,
  );
}

export function LanguageSection({ burrow }: { burrow: string }) {
  const ids = useId();
  const { t, language } = useWebI18n();
  const control = useWebLocaleControl();
  const { client, queryClient } = useAppServices();
  const toast = useToast();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const [saving, setSaving] = useState(false);
  // The voice note shows after the person chose Dutch here, not every time the page opens.
  const dutchChosen = useChoseDutch();
  const stored = bootstrap?.preferences.locale ?? null;
  // What the page shows: it changes at once, before the box has saved it.
  const current: Language = language;

  const put = (preferences: Preferences) => {
    queryClient.setQueryData(
      queryKeys.conversations.bootstrap({ params: { burrow } }),
      (old: Bootstrap | undefined) => old && { ...old, preferences },
    );
    queryClient.setQueryData(queryKeys.me.getPreferences({}), preferences);
  };

  const choose = async (next: Language) => {
    if (next === current || saving) return;
    const tag = storedLocaleOf(next);
    const before = stored ?? storedLocaleOf(current);
    setSaving(true);
    control?.setLocale(tag);
    try {
      const result = await client.me.updatePreferences({ body: { locale: tag } });
      if (result.status !== 'ok') throw new Error('not saved');
      put(result.data);
      setChoseDutch(next === 'nl');
      // What the box wrote in the old language is read again in the new one.
      control?.refreshServerText();
    } catch {
      control?.setLocale(before);
      toast.show(t('settings.language.notSaved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-section="language">
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.language.section')}
      </SectionLabel>
      <div className={styles.card}>
        <div className={`${styles.row} ${styles.lastRow}`} data-language-row="">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={`${ids}-title`}>
              {t('settings.language.title')}
            </span>
            <span className={styles.rowMeta} id={`${ids}-hint`}>
              {t('settings.language.hint')}
            </span>
          </span>
          <SegmentedControl
            label={t('settings.language.title')}
            role="radiogroup"
            size="sm"
            describedBy={`${ids}-hint`}
            options={SUPPORTED_LANGUAGES.map((lang) => ({ value: lang, label: LANGUAGE_NATIVE_NAMES[lang] }))}
            value={current}
            onChange={(v) => void choose(v as Language)}
          />
        </div>
      </div>
      {dutchChosen && current === 'nl' ? <DutchVoiceNote /> : null}
    </section>
  );
}

/**
 * The gentle note after choosing Dutch: the box can speak Dutch too, turned on (and its licence agreed to) in Settings
 * → This Whombat. Shown only where the box offers the Dutch voice and it is off; it never turns anything on.
 */
function DutchVoiceNote() {
  const { t } = useWebI18n();
  const api = useOptionalAppServices()?.voice ?? null;
  const voice = useVoice(api);
  const dutch = voice.data?.dutchVoice;
  if (!api || !voice.data?.available || !dutch || dutch.on) return null;
  return (
    <p className={styles.sectionNote} role="status" data-dutch-voice-note="">
      {t('settings.language.voiceNote')}{' '}
      <Link to="/settings" search={{ tab: 'appliance' } as never}>
        {t('settings.language.voiceLink')}
      </Link>
    </p>
  );
}
