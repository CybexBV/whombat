/**
 * Alerts for mutations that did not go through (keys-engine outcomes and transport errors: `showFailure`,
 * `showHeldBack`), and a quiet note for one that did but whose effect is elsewhere (`showNotice`).
 */
import { type CommitResult, type LookFixOutcome, problemText } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { useMemo } from 'react';
import { Alert, Platform, ToastAndroid } from 'react-native';
import { showToast } from '../data/toast';
import { mobileTranslator, useI18n } from '../i18n';

/**
 * A short, non-modal note that something went through where the screen doesn't show it (a nudge posted in a lane):
 * Android's toast; on iPhone the app's own toast, which goes by itself, since iOS has no toast and an alert to tap away
 * after every small success isn't how an iPhone app confirms one.
 */
export function showNotice(text: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(text, ToastAndroid.SHORT);
  else showToast(text);
}

/**
 * Something the person did didn't go through: an alert they tap away, so it can't flash by unseen as a toast can.
 * `showNotice` is only for successes.
 */
export function showFailure(text: string, locale?: string | null): void {
  Alert.alert(mobileTranslator(locale).t('screens2.feedback.failedTitle'), text);
}

/** A change held back (a key it needs, a person's OK first): its title and why, in an alert. */
export function showHeldBack(text: { title: string; body: string }): void {
  Alert.alert(text.title, text.body);
}

/** A look's step that didn't go through: a refusal or a failure in an alert; one no longer needed is a quiet note. */
export function showLookFix(outcome: LookFixOutcome, text: string, locale?: string | null): void {
  if (outcome === 'gone') showNotice(text);
  else showFailure(text, locale);
}

export function outcomeText(
  result: CommitResult<unknown>,
  locale?: string | null,
): { title: string; body: string } | null {
  const tr = mobileTranslator(locale);
  switch (result.status) {
    case 'ok':
      return null;
    case 'blocked':
      return {
        title: tr.t('screens2.feedback.blockedTitle'),
        body: tr.t('screens2.feedback.blockedBody', { key: result.keyNeeded.label }),
      };
    case 'pending_approval':
      return {
        title: tr.t('screens2.feedback.pendingTitle'),
        body: tr.t('screens2.feedback.pendingBody', { number: result.approvalNumber }),
      };
  }
}

export function errorText(error: unknown, locale?: string | null): string {
  // The appliance's subscription ended, or the plan's limit is reached.
  const licence = licenceRefusalText(error, locale);
  if (licence) return licence;
  return problemText(error, mobileTranslator(locale).t('screens2.feedback.wentWrong'), locale);
}

export function useDecisionFeedback() {
  const { rawLocale } = useI18n();
  return useMemo(
    () => ({
      onResult: (result: CommitResult<unknown>) => {
        const text = outcomeText(result, rawLocale);
        if (text) Alert.alert(text.title, text.body);
      },
      onError: (error: unknown) => showFailure(errorText(error, rawLocale), rawLocale),
      /** The server's own words for a refusal (a guide card's act). */
      onText: (text: string) => showFailure(text, rawLocale),
    }),
    [rawLocale],
  );
}
