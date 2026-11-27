/**
 * A small “English · Nederlands” choice for pages shown before the person has an account or a box (a shared link, the
 * claim, signing in). Each name is in its own language, so a reader finds theirs whichever one is shown.
 */
import { LANGUAGE_NATIVE_NAMES, type Language, SUPPORTED_LANGUAGES } from '@whombat/core/i18n';
import styles from './LanguageSwitch.module.css';
import { browserLocale, readLocaleOverride, storedLocaleOf } from './locale';
import { useWebI18n, useWebLocaleControl } from './provider';

export function LanguageSwitch({
  onChange,
  className,
  onlyWhenAsked = false,
}: {
  onChange?: (tag: string) => void;
  className?: string;
  /**
   * Show it only to someone who may want Dutch: the page or their browser is in another language than English, or
   * they chose one in this tab. An English reader of an English page sees the page as it always was.
   */
  onlyWhenAsked?: boolean;
}) {
  const control = useWebLocaleControl();
  const { t, language } = useWebI18n();
  if (!control) return null;
  if (
    onlyWhenAsked &&
    language === 'en' &&
    browserLocale() === storedLocaleOf('en') &&
    !readLocaleOverride()
  ) {
    return null;
  }
  const choose = (next: Language) => {
    const tag = storedLocaleOf(next);
    control.setLocale(tag);
    onChange?.(tag);
  };
  return (
    <nav className={[styles.switch, className].filter(Boolean).join(' ')} aria-label={t('language.label')}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          className={styles.option}
          aria-pressed={language === lang}
          onClick={() => choose(lang)}
        >
          {LANGUAGE_NATIVE_NAMES[lang]}
        </button>
      ))}
    </nav>
  );
}
