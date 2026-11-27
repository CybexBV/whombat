/**
 * Settings → You → Profile → LANGUAGE: English or Nederlands for the whole Whombat (the app, the assistant's replies,
 * notifications and emails), saved in the account's preferences (`me.updatePreferences`, `locale`) like the theme. The
 * picker shows the choice at once; the page changes language once the box has saved it, so the stored language never
 * pulls the page back to the old one and what the box writes is asked for again only after the save.
 *
 * A Whombat from before languages keeps no language: there the row says the update brings it instead of offering a
 * choice it would drop, and a save the box answered without the language counts as not saved.
 *
 * Switching to Dutch never turns on the Dutch voice: it has a licence of its own the person agrees to in Settings →
 * This Whombat. Where the box offers it and it is off, a quiet note says where to find it.
 */
import { Link } from '@tanstack/react-router';
import { queryKeys } from '@whombat/client/query';
import { useSessionProtocol } from '@whombat/client/react';
import { useVoice } from '@whombat/client/voice/react';
import type { Bootstrap, Preferences } from '@whombat/core';
import {
  LANGUAGE_NATIVE_NAMES,
  type Language,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
} from '@whombat/core/i18n';
import { LOCALE_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { useId, useState, useSyncExternalStore } from 'react';
import { useAppServices, useOptionalAppServices } from '../../app/providers';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { cleanLocaleTag, readLocaleOverride, storedLocaleOf } from '../../i18n/locale';
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

/** Whether the box saved the language asked for: an older box answers the save but leaves the language out. */
export function savedLanguage(preferences: Preferences, asked: Language): boolean {
  const saved = cleanLocaleTag(preferences.locale);
  return saved !== null && resolveLanguage(saved) === asked;
}

export function LanguageSection({ burrow }: { burrow: string }) {
  const ids = useId();
  const keepsLanguage = protocolAtLeast(useSessionProtocol(), LOCALE_MINOR);
  const { t, language } = useWebI18n();
  const control = useWebLocaleControl();
  const { client, queryClient } = useAppServices();
  const toast = useToast();
  // The language being saved: the picker shows it while the box saves, the page keeps its language until then.
  const [pending, setPending] = useState<Language | null>(null);
  // The voice note shows after the person chose Dutch here, not every time the page opens.
  const dutchChosen = useChoseDutch();
  const current: Language = pending ?? language;

  const put = async (preferences: Preferences) => {
    const bootstrapKey = queryKeys.conversations.bootstrap({ params: { burrow } });
    const preferencesKey = queryKeys.me.getPreferences({});
    // A read that left before the save would land after it with the old language and pull the page back.
    await Promise.all([
      queryClient.cancelQueries({ queryKey: bootstrapKey }),
      queryClient.cancelQueries({ queryKey: preferencesKey }),
    ]);
    queryClient.setQueryData(bootstrapKey, (old: Bootstrap | undefined) => old && { ...old, preferences });
    queryClient.setQueryData(preferencesKey, preferences);
  };

  const choose = async (next: Language) => {
    if (next === current || pending) return;
    const tag = storedLocaleOf(next);
    setPending(next);
    try {
      const result = await client.me.updatePreferences({ body: { locale: tag } });
      if (result.status !== 'ok' || !savedLanguage(result.data, next)) throw new Error('not saved');
      // The cached preferences carry the new language before the page changes, so the shell's sync with the stored
      // language agrees with the choice instead of switching back.
      await put(result.data);
      setChoseDutch(next === 'nl');
      control?.setLocale(tag);
      // A changed language asks for the box's words again by itself; a `?lang=` test language keeps the page as it is,
      // so ask here.
      if (readLocaleOverride()) control?.refreshServerText();
    } catch {
      toast.show(t('settings.language.notSaved'));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-section="language">
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t('settings.language.section')}
      </SectionLabel>
      <div className={styles.card}>
        <div
          className={`${styles.row} ${styles.lastRow}`}
          data-language-row=""
          data-saving={pending ? '' : undefined}
          aria-busy={pending ? true : undefined}
        >
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={`${ids}-title`}>
              {t('settings.language.title')}
            </span>
            <span
              className={styles.rowMeta}
              id={`${ids}-hint`}
              data-language-needs-update={keepsLanguage ? undefined : ''}
            >
              {t(keepsLanguage ? 'settings.language.hint' : 'settings.language.needsUpdate')}
            </span>
          </span>
          {keepsLanguage ? (
            <SegmentedControl
              label={t('settings.language.title')}
              role="radiogroup"
              size="sm"
              describedBy={`${ids}-hint`}
              options={SUPPORTED_LANGUAGES.map((lang) => ({
                value: lang,
                label: LANGUAGE_NATIVE_NAMES[lang],
              }))}
              value={current}
              onChange={(v) => void choose(v as Language)}
            />
          ) : null}
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
