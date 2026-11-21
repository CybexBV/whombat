/**
 * Alerts for mutations that did not go through (keys-engine outcomes and transport errors: `showFailure`,
 * `showHeldBack`), and a quiet note for one that did but whose effect is elsewhere (`showNotice`).
 */
import { type CommitResult, type LookFixOutcome, problemText } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { useMemo } from 'react';
import { Alert, Platform, ToastAndroid } from 'react-native';
import { showToast } from '../data/toast';

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
export function showFailure(text: string): void {
  Alert.alert(FAILED_TITLE, text);
}

/** A change held back (a key it needs, a person's OK first): its title and why, in an alert. */
export function showHeldBack(text: { title: string; body: string }): void {
  Alert.alert(text.title, text.body);
}

const FAILED_TITLE = 'That didn’t go through';

/** A look's step that didn't go through: a refusal or a failure in an alert; one no longer needed is a quiet note. */
export function showLookFix(outcome: LookFixOutcome, text: string): void {
  if (outcome === 'gone') showNotice(text);
  else showFailure(text);
}

export function outcomeText(result: CommitResult<unknown>): { title: string; body: string } | null {
  switch (result.status) {
    case 'ok':
      return null;
    case 'blocked':
      return { title: 'You don’t hold that key', body: `This needs “${result.keyNeeded.label}”.` };
    case 'pending_approval':
      return {
        title: 'Waiting for a person',
        body: `This asks a person first (request #${result.approvalNumber}).`,
      };
  }
}

export function errorText(error: unknown): string {
  // The appliance's subscription ended, or the plan's limit is reached (LC-14).
  const licence = licenceRefusalText(error);
  if (licence) return licence;
  return problemText(error, 'Something went wrong. Try again.');
}

export function useDecisionFeedback() {
  return useMemo(
    () => ({
      onResult: (result: CommitResult<unknown>) => {
        const text = outcomeText(result);
        if (text) Alert.alert(text.title, text.body);
      },
      onError: (error: unknown) => showFailure(errorText(error)),
      /** The server's own words for a refusal (a guide card's act). */
      onText: (text: string) => showFailure(text),
    }),
    [],
  );
}
