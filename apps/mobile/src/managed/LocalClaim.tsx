/**
 * Claiming a Whombat at its address on this network (docs/decisions/whombat-link.md): a box without a
 * secure address shows its four letters on its screen with that address, and the person types both here. The claim
 * runs over an enrollment session straight to the box (its Noise session on the local network): the letters are its
 * CPace password, bound to both Noise keys (`runLocalClaim`), so only the box on that screen can answer. Each step is
 * checked here by the box's own rules before anything is sent, so no try is spent on a typo; the name and email go only
 * once the box proved it is the one on that screen. Then the app opens it.
 */

import {
  communityText,
  type KnownAppliance,
  localClaimLettersReady,
  localClaimNext,
  runLocalClaim,
} from '@whombat/client/managed';
import { type ApplianceSession, createSecureSession } from '@whombat/client/session';
import { claimAccountProblem } from '@whombat/protocol/session';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, type TextInput, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { useClaimLocale } from '../i18n/provider';
import { Button } from '../ui/primitives';
import { phoneCommunityText } from './community';
import { APP_BUILD } from './config';
import { type EndpointKey, type ManagedEnvironment, PHONE_PLATFORM, phoneClient, phoneLabel } from './env';
import { ErrorLine, Field, Frame } from './ui';

export function LocalClaim({
  env,
  keyPair,
  record,
  notice,
  onBack,
  onClaimed,
  onTaken,
  onReread,
}: {
  env: ManagedEnvironment;
  keyPair: EndpointKey;
  /** The box at the typed address: the PeerId it named there and its way in on this network. */
  record: KnownAppliance;
  onBack: () => void;
  /** Claimed: this phone is the owner's first device. */
  onClaimed: (accountId: string) => void;
  /** Someone else claimed it meanwhile: the box is asked again what it is now. */
  onTaken: () => void;
  /** What the letters screen says first: why the claim is back here after the box was asked again. */
  notice?: string | null;
  /**
   * The connection or the proof was lost in the middle of the claim: the box is asked again what it is now, and when
   * nobody claimed it the letters come back with `text`.
   */
  onReread: (text: string) => void;
}) {
  const { rawLocale, tClient } = useI18n();
  const communityTextHere = communityText(rawLocale);
  const { t: tMobile } = useMobileT();
  const { claim: claimText } = communityTextHere;
  const phoneCommunityTextHere = phoneCommunityText(rawLocale);

  const locale = useClaimLocale();
  const [stage, setStage] = useState<'letters' | 'account'>('letters');
  const [letters, setLetters] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [lettersProblem, setLettersProblem] = useState<string | null>(notice ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<ApplianceSession | null>(null);
  const emailField = useRef<TextInput>(null);

  useEffect(() => {
    const s = createSecureSession({
      connector: env.connector({
        orgId: record.orgId,
        device: record.device,
        peerId: record.peerId,
        channel: 'enroll',
        key: keyPair,
        direct: () => record.direct ?? null,
        directOnly: true,
      }),
      client: phoneClient(APP_BUILD),
      expect: 'any',
      backoff: { initialMs: 500, maxMs: 5000 },
    });
    s.connect();
    setSession(s);
    return () => s.close();
  }, [env, keyPair, record]);

  const back = () => {
    if (busy) return;
    if (stage === 'account') setStage('letters');
    else onBack();
  };
  // Android back: a step back, then out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  });

  const claim = async () => {
    if (!session || busy) return;
    // The box's own rules for a name and an email, before a try is spent on the exchange.
    const invalid = claimAccountProblem({ name, email });
    if (invalid) {
      setProblem(
        invalid === 'name' ? tMobile('localClaim.account.badName') : tMobile('localClaim.account.badEmail'),
      );
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const out = await runLocalClaim({
        locale,
        session,
        letters,
        appliancePeerId: record.peerId,
        clientPeerId: keyPair.peerId,
        account: { name: name.trim(), email: email.trim() },
        endpoint: { label: phoneLabel(rawLocale), platform: PHONE_PLATFORM },
      });
      onClaimed(out.accountId);
    } catch (error) {
      const next = localClaimNext(error, Date.now(), rawLocale);
      // Another phone won: this one reads the box again and joins it as a second device would.
      if (next.to === 'taken') onTaken();
      // The connection or the proof was lost on the way: the box says what it is now before anything is asked again.
      else if (next.to === 'reread') onReread(next.text);
      // A wrong guess, or a proof that ran out: the box may show other letters, so they are asked again.
      else if (next.to === 'letters') {
        setLetters('');
        setLettersProblem(next.text);
        setStage('letters');
      } else setProblem(next.text);
    } finally {
      setBusy(false);
    }
  };

  const kicker = phoneCommunityTextHere.claim.kicker;
  const backLink = { label: tMobile('managed.back'), onPress: back };
  if (stage === 'letters') {
    const ready = letters.trim().length >= 4;
    const next = () => {
      if (!ready) return;
      // Four letters of the box's alphabet (it has no I, L, O, S, U or Z): anything else is a misread.
      if (!localClaimLettersReady(letters)) {
        setLettersProblem(tMobile('claim.malformed'));
        return;
      }
      setLettersProblem(null);
      setStage('account');
    };
    return (
      <Frame
        kicker={kicker}
        title={tClient('managed.claim.title')}
        sub={tMobile('localClaim.sub')}
        tip={tMobile('localClaim.tip')}
        back={backLink}
      >
        <Field
          label={tMobile('localClaim.letters')}
          value={letters}
          onChangeText={(v) => {
            setLetters(
              v
                .toUpperCase()
                .replace(/[^A-Z]/g, '')
                .slice(0, 4),
            );
            setLettersProblem(null);
          }}
          placeholder={claimText.lettersPlaceholder}
          mono
          autoFocus
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          maxLength={4}
          returnKeyType="next"
          onSubmitEditing={next}
        />
        <ErrorLine text={lettersProblem} />
        <Button label={tMobile('localClaim.next')} size="lg" disabled={!ready} onPress={next} />
      </Frame>
    );
  }
  const ready = Boolean(name.trim() && email.trim());
  return (
    <Frame
      kicker={kicker}
      title={tMobile('localClaim.account.title')}
      sub={tMobile('localClaim.account.sub')}
      tip={tMobile('localClaim.account.tip')}
      back={backLink}
    >
      <View style={{ gap: 12 }}>
        <Field
          label={tMobile('localClaim.account.name')}
          value={name}
          onChangeText={(v) => {
            setName(v);
            setProblem(null);
          }}
          autoFocus
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => emailField.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={emailField}
          label={tMobile('localClaim.account.email')}
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setProblem(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="go"
          editable={!busy}
          onSubmitEditing={() => ready && void claim()}
        />
      </View>
      <ErrorLine text={problem} />
      <Button
        label={busy ? tClient('managed.claim.claiming') : tClient('managed.claim.claim')}
        size="lg"
        busy={busy}
        disabled={!ready || !session}
        onPress={() => void claim()}
      />
    </Frame>
  );
}
