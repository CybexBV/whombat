/**
 * Signing in at the box's screen on the phone (BX-02, signin-at-box-android.md AP-3528…): the way in on “Let this device
 * in” and “Set up this device”, then the flow's two screens — “Show a code”, then the six letters from the box's screen
 * and “Let this device in”. Thin: the steps, the exchange and every
 * word are the shared client's (`screen-signin.ts`, `COPY.screen`); this is the phone's look of them (the managed
 * journeys' `Frame`, 44dp targets, the keyboard in capitals with Android's one-time-code autofill).
 */

import {
  formatScreenLettersInput,
  type ScreenSignInDeps,
  type ScreenSignInStep,
  screenSignInRequest,
  screenSignInStart,
  screenSignInSubmit,
} from '@whombat/client/managed';
import type { ApplianceSession } from '@whombat/client/session';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { useMobileT } from '../i18n';
import { Screen } from '../ui/headers';
import { Button, Loading } from '../ui/primitives';
import { COPY } from './copy';
import { backFrom, lettersAfter } from './screenSignIn';
import { Card, ErrorLine, Field, Frame, Row } from './ui';

const T = COPY.screen;

/** “At your Whombat? Its screen can show a code for this device.” with “Use its screen”: a row like a way in. */
export function ScreenWayRow({ onUse }: { onUse: () => void }) {
  return (
    <Card>
      <Row first title={T.way} action={<Button label={T.use} variant="secondary" onPress={onUse} />} />
    </Card>
  );
}

function ScreenStartScreen({
  busy,
  error,
  onShow,
  back,
}: {
  busy: boolean;
  error: string | null;
  onShow: () => void;
  back: { label: string; onPress: () => void };
}) {
  return (
    <Frame kicker={T.kicker} title={T.title} sub={T.sub} tip={T.tip} back={back}>
      <ErrorLine text={error} />
      <Button label={T.show} size="lg" busy={busy} onPress={onShow} />
    </Frame>
  );
}

function ScreenLettersScreen({
  letters,
  onLetters,
  busy,
  error,
  onGo,
  onNewCode,
  back,
}: {
  /** As typed, grouped `KXQ MTR` (`formatScreenLettersInput`). */
  letters: string;
  onLetters: (v: string) => void;
  busy: boolean;
  error: string | null;
  onGo: () => void;
  onNewCode: () => void;
  back: { label: string; onPress: () => void };
}) {
  // Six typed: “Let this device in” checks them (a letter the box never shows is said there).
  const ready = letters.replace(/\s/g, '').length === 6;
  return (
    <Frame kicker={T.kicker} title={T.typeTitle} sub={T.typeSub} tip={T.tip} back={back}>
      <Field
        label={T.letters}
        value={letters}
        onChangeText={(v) => onLetters(formatScreenLettersInput(v))}
        mono
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        importantForAutofill="yes"
        // Six letters and the space between the groups.
        maxLength={7}
        returnKeyType="go"
        onSubmitEditing={() => ready && !busy && onGo()}
      />
      <ErrorLine text={error} />
      <View style={{ gap: 12 }}>
        <Button label={T.go} size="lg" busy={busy} disabled={!ready} onPress={onGo} />
        <Button label={T.newCode} variant="secondary" disabled={busy} onPress={onNewCode} />
      </View>
    </Frame>
  );
}

/** A stop the machine can't get past here (too old, no screen, not the box on the screen): what happened, and Back. */
function ScreenStoppedScreen({ error, onBack }: { error: string; onBack: () => void }) {
  const { t: tMobile } = useMobileT();
  return (
    <Frame kicker={T.kicker} title={T.title} sub={error}>
      <Button label={tMobile('managed.back')} size="lg" onPress={onBack} />
    </Frame>
  );
}

/**
 * The flow over an enrollment session to the box (`session`, connected with `appliancePeerId`): “Show a code”, the
 * letters, then `onIn` with the account once the box's tag matched (or `onAlready` when this key is let in there
 * already). Android's back goes a step back, then out (`onBack`).
 */
export function ScreenSignInSteps({
  onBack,
  onIn,
  onAlready,
  ...deps
}: Omit<ScreenSignInDeps, 'randomBytes' | 'now'> & {
  session: ApplianceSession;
  onBack: () => void;
  onIn: (accountId: string) => void;
  onAlready: () => void;
}) {
  const [step, setStep] = useState<ScreenSignInStep>(() => screenSignInStart());
  const [letters, setLetters] = useState('');
  const [busy, setBusy] = useState(false);
  const done = useRef({ onIn, onAlready });
  done.current = { onIn, onAlready };
  useEffect(() => {
    if (step.kind === 'enrolled') done.current.onIn(step.output.accountId);
    else if (step.kind === 'already') done.current.onAlready();
  }, [step]);
  const goBack = useCallback(() => {
    const to = backFrom(step);
    if (to) setStep(to);
    else onBack();
  }, [step, onBack]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [goBack]);

  const take = async (next: Promise<ScreenSignInStep>) => {
    setBusy(true);
    const s = await next;
    setLetters((typed) => lettersAfter(step, s, typed));
    setStep(s);
    setBusy(false);
  };
  const back = { label: 'Back', onPress: goBack };
  // What was said about the last try goes once something new is typed.
  const typing = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (step.kind === 'letters' && step.error) setStep({ ...step, error: null });
  };

  if (step.kind === 'enrolled' || step.kind === 'already')
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  if (step.kind === 'stopped') return <ScreenStoppedScreen error={step.error} onBack={onBack} />;
  if (step.kind === 'start')
    return (
      <ScreenStartScreen
        busy={busy}
        error={step.error}
        onShow={() => void take(screenSignInRequest(deps, step))}
        back={back}
      />
    );
  return (
    <ScreenLettersScreen
      letters={letters}
      onLetters={typing(setLetters)}
      busy={busy}
      error={step.error}
      onGo={() => void take(screenSignInSubmit(deps, step, letters))}
      onNewCode={() => void take(screenSignInRequest(deps, step))}
      back={back}
    />
  );
}
