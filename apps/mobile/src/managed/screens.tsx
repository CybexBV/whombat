/**
 * The phone's managed journeys outside an appliance (AP-22, AP-27), mirroring the web's (`apps/web/src/managed/
 * screens.tsx`): cloud sign-in by magic link, the first-run organization, the appliance list, claim (the letters on
 * the screen of a Whombat on this network, or its card scanned or typed; AP-47, AP-50), the recovery kit made from This
 * Whombat (save through the share sheet → “I’ve saved the kit”), pairing, signing in at the box's screen (BX-02), and
 * the plain full-page states a session can end in. Not mocked: they follow the sign-in screen.
 */

import {
  type ApplianceSummary,
  agoText,
  appliancesEmptyText,
  type ClaimCard,
  type ClaimRequest,
  type ControlApi,
  type ControlSession,
  formatClaimLettersInput,
  isKitBackupGap,
  isRetired,
  type KitBackup,
  type KitBackupGap,
  kitBackupText,
  type LocalLinkParts,
  lettersRequestOf,
  listedAppliances,
  loadKitBackup,
  modelLabel,
  type NearbyAppliance,
  newRecoveryKit,
  PASSKEY_COPY,
  PasskeyCancelled,
  type PasskeyPlatform,
  type PhoneSignInLink,
  parseClaimQr,
  parseSetupLink,
  passkeyErrorText,
  type RecoveryKit,
  readKitFile,
  recoverySecretFromKey,
  rotationSignature,
  type SavedKit,
  type SetupLink,
  signInErrorText,
  whombatNameError,
} from '@whombat/client/managed';
import { type ApplianceSession, OperationError, sessionOps } from '@whombat/client/session';
import { normalizeClaimSecret } from '@whombat/protocol/session';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button, Loading } from '../ui/primitives';
import { phoneCommunityText } from './community';
import { UI_ORIGINS } from './config';
import { COPY, managedCopy } from './copy';
import { type KitPrinter, KitWays } from './KitWays';
import { OrDivider, PhoneHero, PhoneScanner, ScanButton } from './PhoneSignInScreens';
import { QrScanner } from './QrScanner';
import { ScreenWayRow } from './ScreenSignInScreens';
import { Card, ErrorLine, Field, Frame, Note, Row } from './ui';

/* Sign in ------------------------------------------------------------------------------------------------ */

/**
 * Signed out. QR first (AP-530): the computer's “Mobile app” page shows a code that signs this phone in and lets it in
 * to the Whombat open there. Email (the magic link) stays, one tap away.
 */
/** A failure of a passkey ceremony, said in the screen's error line; null when the person just closed the prompt. */
function passkeyFailureText(error: unknown): string | null {
  return error instanceof PasskeyCancelled ? null : passkeyErrorText(error);
}

/** “Sign in with a passkey” (PK-04, passkeys.md AP-799): one touch signs in and opens the Whombat the passkey names. */
function PasskeyButton({
  onPasskey,
  onError,
  label = PASSKEY_COPY.signIn,
}: {
  onPasskey: () => Promise<void>;
  onError: (text: string | null) => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label={label}
      variant="secondary"
      size="lg"
      busy={busy}
      accessibilityHint={PASSKEY_COPY.signInHint}
      onPress={() => {
        setBusy(true);
        onError(null);
        onPasskey()
          .catch((e: unknown) => onError(passkeyFailureText(e)))
          .finally(() => setBusy(false));
      }}
    />
  );
}

export function SignInScreen({
  onSend,
  onPhoneLink,
  initialMode = 'scan',
  onPasskey,
  community,
}: {
  onSend: (email: string) => Promise<void>;
  onPhoneLink: (link: PhoneSignInLink) => void;
  initialMode?: 'scan' | 'email';
  /** Sign in with a passkey; absent without Credential Manager. Rejects with the failure. */
  onPasskey?: () => Promise<void>;
  /**
   * Community Whombats, without a cloud account (AP-5471): the ones this phone was added to (each opens with one tap),
   * Add this phone with a link or QR code, and a community box's link scanned with the sign-in scanner.
   */
  community?: {
    boxes: readonly { device: string; name: string | null }[];
    onOpen: (device: string) => void;
    onJoin: () => void;
    onLink: (link: LocalLinkParts) => void;
  };
}) {
  const { rawLocale, tClient } = useI18n();
  const phoneCommunityTextHere = phoneCommunityText(rawLocale);
  const managedCopyHere = managedCopy(rawLocale);

  const [mode, setMode] = useState(initialMode);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(address);
      setSent(address);
    } catch (err) {
      setError(signInErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const toEmail = () => {
    setScanning(false);
    setMode('email');
  };
  const scanner = (
    <PhoneScanner
      visible={scanning}
      onClose={() => setScanning(false)}
      onDenied={() => {
        setScanning(false);
        setScanError(managedCopyHere.phone.scanDenied);
      }}
      onLink={(link) => {
        setScanning(false);
        onPhoneLink(link);
      }}
      escapeLabel={managedCopyHere.signIn.withEmail}
      onEscape={toEmail}
      {...(community && {
        onLocalLink: (link: LocalLinkParts) => {
          setScanning(false);
          community.onLink(link);
        },
      })}
    />
  );
  const C = phoneCommunityTextHere.signIn;
  const communityPart = community ? (
    <>
      {community.boxes.length > 0 ? (
        <Card label={C.known}>
          {community.boxes.map((b, i) => (
            <Row
              key={b.device}
              first={i === 0}
              dot="ok"
              dotLabel={C.openMeta}
              title={b.name ?? C.unnamed}
              meta={C.openMeta}
              action={
                <Button
                  label={tClient('automations.waiting.open')}
                  variant="secondary"
                  accessibilityLabel={C.open(b.name ?? C.unnamed)}
                  onPress={() => community.onOpen(b.device)}
                />
              }
            />
          ))}
        </Card>
      ) : null}
      <Button label={C.joinLink} variant="quiet" onPress={community.onJoin} />
    </>
  ) : null;
  if (sent)
    return (
      <Frame
        kicker={managedCopyHere.signIn.kicker}
        title={managedCopyHere.signIn.sentTitle}
        sub={managedCopyHere.signIn.sent(sent)}
        tip={managedCopyHere.signIn.tip}
      >
        <Note text={managedCopyHere.signIn.openHint} />
        <Button label={managedCopyHere.signIn.again} variant="quiet" onPress={() => setSent(null)} />
      </Frame>
    );
  if (mode === 'email')
    return (
      <Frame
        kicker={managedCopyHere.signIn.kicker}
        title={managedCopyHere.signIn.emailTitle}
        sub={managedCopyHere.signIn.sub}
        tip={managedCopyHere.signIn.tip}
      >
        <Field
          label={managedCopyHere.signIn.email}
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          onSubmitEditing={() => void send()}
        />
        <ErrorLine text={error} />
        <Button
          label={managedCopyHere.signIn.send}
          size="lg"
          busy={busy}
          disabled={!email.trim()}
          onPress={() => void send()}
        />
        {onPasskey ? <PasskeyButton onPasskey={onPasskey} onError={setError} /> : null}
        <Button
          label={managedCopyHere.signIn.withScan}
          variant="quiet"
          onPress={() => {
            setMode('scan');
            setScanError(null);
            setScanning(true);
          }}
        />
        {scanner}
      </Frame>
    );
  return (
    <Frame
      kicker={managedCopyHere.signIn.kicker}
      title={managedCopyHere.signIn.scanTitle}
      sub={managedCopyHere.signIn.scanSub}
      tip={managedCopyHere.signIn.scanTip}
      hero={<PhoneHero />}
    >
      <ScanButton
        label={managedCopyHere.signIn.scan}
        onPress={() => {
          setScanError(null);
          setScanning(true);
        }}
      />
      {onPasskey ? <PasskeyButton onPasskey={onPasskey} onError={setScanError} /> : null}
      <ErrorLine text={scanError} />
      <Button label={managedCopyHere.signIn.withEmail} variant="quiet" onPress={toEmail} />
      {communityPart}
      {scanner}
    </Frame>
  );
}

export function VerifyScreen({ error, onBack }: { error: string | null; onBack: () => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Frame
      kicker={managedCopyHere.signIn.kicker}
      title={error ? managedCopyHere.signIn.title : managedCopyHere.signIn.verifying}
      sub={error}
      tip={managedCopyHere.signIn.tip}
    >
      {error ? <Button label={managedCopyHere.signIn.again} variant="secondary" onPress={onBack} /> : null}
    </Frame>
  );
}

/* First run: the organization, on the web (AP-130) --------------------------------------------------------------- */

/**
 * A cloud account with no Whombat yet (LNK-44): a Whombat is joined with its QR code or address, never set up or bought
 * here (no sign-up, plan or price in the app, on the iPhone above all). “Check again” asks control again, for a Whombat
 * linked to this account meanwhile.
 */
export function CreateOrgScreen({
  onJoin,
  onDone,
  onSignOut,
}: {
  onJoin: () => void;
  onDone: () => void;
  onSignOut: () => void;
}) {
  const { rawLocale } = useI18n();
  const phoneCommunityTextHere = phoneCommunityText(rawLocale);

  const t = phoneCommunityTextHere.noWhombat;
  return (
    <Frame kicker={t.kicker} title={t.title} sub={t.sub}>
      <Button label={t.join} size="lg" onPress={onJoin} />
      <Button label={t.again} variant="secondary" size="lg" onPress={onDone} />
      <Button label={t.signOut} variant="quiet" onPress={onSignOut} />
    </Frame>
  );
}

/* Appliance list ------------------------------------------------------------------------------------------ */

export function AppliancesScreen({
  session,
  appliances,
  error,
  notice = null,
  onOpen,
  onClaim,
  onSignOut,
  onRefresh,
  canRecover,
  onRecover,
  remembers = () => false,
  onForget,
  onDeleteAccount,
  onRename,
}: {
  session: ControlSession;
  /** The organization's directory (retired Whombats included); null while it loads. */
  appliances: ApplianceSummary[] | null;
  error: string | null;
  /** Why the list opened in place of a Whombat (AP-696): “Burrow HQ was retired. …”. */
  notice?: string | null;
  onOpen: (a: ApplianceSummary) => void;
  onClaim: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
  /** This phone isn't (or no longer) let in there: offer the recovery kit (AP-41). */
  canRecover?: (a: ApplianceSummary) => boolean;
  onRecover?: (a: ApplianceSummary) => void;
  /** This phone still remembers a retired Whombat (AP-696): it is listed as Retired, to forget. */
  remembers?: (device: string) => boolean;
  /** Forget a retired Whombat on this phone. */
  onForget?: (a: ApplianceSummary) => void;
  /** Delete the cloud account (CT-78, AP-73). */
  onDeleteAccount?: () => void;
  /** Name a Whombat in the directory (AP-3086); resolves to why it failed, or null. */
  onRename?: (a: ApplianceSummary, name: string) => Promise<string | null>;
}) {
  const { rawLocale, tClient } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const theme = useTheme();
  const now = Date.now();
  const rows = appliances ? listedAppliances(appliances, remembers) : [];
  const [naming, setNaming] = useState<string | null>(null);
  const named = rows.find((a) => a.device === naming && !isRetired(a));
  // No Whombat in use (none, or every one retired): the claim is what's left (AP-75, AP-696).
  const empty = appliances ? appliancesEmptyText(appliances) : null;
  return (
    <Frame
      kicker={managedCopyHere.appliances.kicker}
      title={managedCopyHere.appliances.title}
      sub={managedCopyHere.appliances.sub}
      tip={managedCopyHere.appliances.tip}
    >
      {notice ? (
        <Card>
          <View style={{ paddingVertical: 14, paddingHorizontal: 16 }}>
            <Text size={14.5} lh={1.45} accessibilityLiveRegion="polite">
              {notice}
            </Text>
          </View>
        </Card>
      ) : null}
      <ErrorLine text={error} />
      {error ? <Button label={tClient('settings.retry')} variant="secondary" onPress={onRefresh} /> : null}
      {rows.length > 0 ? (
        <Card>
          {rows.map((a, i) => {
            const name = a.name ?? a.device;
            if (isRetired(a))
              return (
                <Row
                  key={a.device}
                  first={i === 0}
                  dot="mut"
                  dotLabel={managedCopyHere.appliances.retired}
                  title={name}
                  muted
                  meta={managedCopyHere.appliances.retired}
                  action={
                    onForget ? (
                      <Button
                        label={managedCopyHere.appliances.forget}
                        variant="secondary"
                        onPress={() => onForget(a)}
                        accessibilityHint={`Forgets ${name} on this phone`}
                      />
                    ) : null
                  }
                />
              );
            const online = a.lastSeenAt !== null && now / 1000 - a.lastSeenAt < 120;
            const meta = [
              online
                ? managedCopyHere.appliances.online
                : a.lastSeenAt
                  ? managedCopyHere.appliances.offline(agoText(a.lastSeenAt, now, rawLocale))
                  : managedCopyHere.appliances.neverSeen,
              a.revocationsPending > 0
                ? managedCopyHere.appliances.pendingRevocations(a.revocationsPending)
                : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <Row
                key={a.device}
                first={i === 0}
                dot={online ? 'ok' : 'mut'}
                dotLabel={online ? managedCopyHere.appliances.online : 'Offline'}
                title={name}
                meta={meta}
                action={
                  <Button
                    label={managedCopyHere.appliances.open}
                    variant="secondary"
                    onPress={() => onOpen(a)}
                    accessibilityHint={`Opens ${name}`}
                  />
                }
              />
            );
          })}
        </Card>
      ) : null}
      {empty ? (
        <Text size={15} lh={1.5} color={theme.colors.mut}>
          {empty}
        </Text>
      ) : null}
      {onRecover
        ? rows
            .filter((a) => !isRetired(a) && canRecover?.(a))
            .map((a) => (
              <Button
                key={a.device}
                label={
                  rows.length > 1
                    ? `${managedCopyHere.recover.lost} · ${a.name ?? a.device}`
                    : managedCopyHere.recover.lost
                }
                variant="quiet"
                onPress={() => onRecover(a)}
              />
            ))
        : null}
      {onRename && named ? (
        <NameEditor
          key={named.device}
          appliance={named}
          onSave={(typed) => onRename(named, typed)}
          onDone={() => setNaming(null)}
        />
      ) : onRename ? (
        rows
          .filter((a) => !isRetired(a))
          .map((a) => {
            const name = a.name ?? a.device;
            return (
              <Button
                key={a.device}
                label={
                  rows.length > 1
                    ? `${managedCopyHere.appliances.rename} · ${name}`
                    : managedCopyHere.appliances.rename
                }
                variant="quiet"
                onPress={() => setNaming(a.device)}
                accessibilityLabel={managedCopyHere.appliances.renameLabel(name)}
              />
            );
          })
      ) : null}
      <Button label={managedCopyHere.appliances.claim} size="lg" onPress={onClaim} />
      <View style={{ gap: 2 }}>
        <Button label={managedCopyHere.appliances.signOut} variant="quiet" onPress={onSignOut} />
        <Text size={12} mono color={theme.colors.mut} style={{ textAlign: 'center' }}>
          {session.account.email}
        </Text>
        {onDeleteAccount ? (
          <Button label={managedCopyHere.account.deleteEntry} variant="quiet" onPress={onDeleteAccount} />
        ) : null}
      </View>
    </Frame>
  );
}

/** A Whombat's name being typed under the list (AP-3086): Save sends it to the directory, Cancel leaves it. */
function NameEditor({
  appliance,
  onSave,
  onDone,
}: {
  appliance: ApplianceSummary;
  onSave: (name: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const [value, setValue] = useState(appliance.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const invalid = whombatNameError(value);
    if (invalid) return setError(invalid);
    setBusy(true);
    const failed = await onSave(value.trim());
    setBusy(false);
    if (failed) setError(failed);
    else onDone();
  };
  return (
    <View style={{ gap: 12 }}>
      <Field
        label={managedCopyHere.appliances.nameLabel(appliance.device)}
        value={value}
        onChangeText={(v) => {
          setValue(v);
          setError(null);
        }}
        placeholder={managedCopyHere.appliances.namePlaceholder}
        autoCapitalize="words"
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <ErrorLine text={error} />
      <Button label={managedCopyHere.appliances.save} busy={busy} onPress={save} />
      <Button label={managedCopyHere.appliances.cancel} variant="quiet" onPress={onDone} />
    </View>
  );
}

/* Claim (CC-09, AP-47) ---------------------------------------------------------------------------------- */

/** The person's name on the Whombat, asked only when the cloud account has none. */
function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Field
      label={managedCopyHere.claim.nameLabel}
      value={value}
      onChangeText={onChange}
      autoCapitalize="words"
      autoComplete="name"
    />
  );
}

/**
 * The four letters from the Whombat's screen (CC-01, CC-13): any case, spaces and dashes are fine. Also pairs the box's
 * screen as a desk display (desk-display-android.md AP-3053).
 */
export function LettersField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hint?: string;
  /** The desk's pairing takes the four letters only. */
  maxLength?: number;
}) {
  return (
    <Field
      label={label}
      value={value}
      onChangeText={(v) => onChange(formatClaimLettersInput(v))}
      mono
      placeholder={placeholder}
      autoCapitalize="characters"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      {...(hint ? { hint } : {})}
      {...(maxLength ? { maxLength } : {})}
    />
  );
}

export interface ClaimScreenProps {
  /** The cloud account has no name: ask for the one this Whombat shows. */
  askName: boolean;
  busy: boolean;
  error: string | null;
  onClaim: (request: ClaimRequest, name: string) => void;
  onBack: () => void;
}

const backToList = (onBack: () => void) => ({ label: COPY.appliances.title, onPress: onBack });

/** `claims.nearby` is on its way. */
export function ClaimLookingScreen({ onBack }: { onBack: () => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Frame
      kicker={managedCopyHere.claim.kicker}
      title={managedCopyHere.claim.title}
      tip={managedCopyHere.claim.tip}
      back={backToList(onBack)}
    >
      <Note text={managedCopyHere.claim.looking} />
    </Frame>
  );
}

/** One box on this network: its four letters are enough (CC-09). */
/**
 * “I agree to the Whombat Appliance Terms” (LC-18): a checkbox, unticked, before the claim button, which stays disabled
 * until it's ticked; the terms open in the browser from the hosted UI. 44px targets.
 */
function TermsCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { rawLocale, language } = useI18n();
  const { t } = useMobileT();
  const managedCopyHere = managedCopy(rawLocale);

  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={managedCopyHere.claim.termsLabel}
        onPress={() => onChange(!checked)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: checked ? theme.colors.btn : theme.colors.line2,
            backgroundColor: checked ? theme.colors.btn : theme.colors.sf,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? (
            <Text size={14} weight={700} color={theme.colors.btnfg}>
              ✓
            </Text>
          ) : null}
        </View>
        <Text size={14.5} color={theme.colors.ink2}>
          {managedCopyHere.claim.termsAgree}{' '}
        </Text>
      </Pressable>
      <Pressable
        onPress={() =>
          void Linking.openURL(`${UI_ORIGINS[0] ?? 'https://app.whombat.com'}/legal/appliance-terms`)
        }
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text size={14.5} color={theme.colors.ink} style={{ textDecorationLine: 'underline' }}>
          {managedCopyHere.claim.termsLink}
        </Text>
      </Pressable>
      {language === 'nl' ? (
        <Text size={13} color={theme.colors.mut} style={{ width: '100%' }}>
          {t('claim.termsEnglish')}
        </Text>
      ) : null}
    </View>
  );
}

export function ClaimFoundScreen({
  box,
  askName,
  busy,
  error,
  onClaim,
  onBack,
  onNotThisOne,
  onCard,
}: ClaimScreenProps & { box: NearbyAppliance; onNotThisOne: () => void; onCard: () => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [bad, setBad] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const submit = () => {
    // Only the four letters: a code claim works only for a box found on this network (CC-13).
    const request = lettersRequestOf(box.device, typed);
    setBad(!request);
    if (request) onClaim(request, name.trim());
  };
  return (
    <Frame
      kicker={managedCopyHere.claim.kicker}
      title={managedCopyHere.claim.foundTitle}
      sub={managedCopyHere.claim.foundSub}
      tip={managedCopyHere.claim.tip}
      back={backToList(onBack)}
    >
      <Card>
        <Row
          first
          dot="ok"
          dotLabel={managedCopyHere.appliances.online}
          title={modelLabel(box.model)}
          meta={box.device}
        />
      </Card>
      <LettersField
        label={managedCopyHere.claim.letters}
        value={typed}
        onChange={setTyped}
        placeholder={managedCopyHere.claim.lettersPlaceholder}
        hint={managedCopyHere.claim.lettersHint}
      />
      {askName ? <NameField value={name} onChange={setName} /> : null}
      <TermsCheck checked={agreed} onChange={setAgreed} />
      <ErrorLine text={bad ? managedCopyHere.claim.malformed : error} />
      <Button
        label={busy ? managedCopyHere.claim.claiming : managedCopyHere.claim.claim}
        size="lg"
        busy={busy}
        disabled={!agreed || !typed.trim() || (askName && !name.trim())}
        onPress={submit}
      />
      <Button label={managedCopyHere.claim.notThisOne} variant="quiet" onPress={onNotThisOne} />
      <Button label={managedCopyHere.claim.withCard} variant="quiet" onPress={onCard} />
    </Frame>
  );
}

/** Several boxes on this network: pick one first (CC-09). */
export function ClaimPickScreen({
  boxes,
  onPick,
  onNone,
  onCard,
  onBack,
}: {
  boxes: NearbyAppliance[];
  onPick: (box: NearbyAppliance) => void;
  onNone: () => void;
  onCard: () => void;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Frame
      kicker={managedCopyHere.claim.kicker}
      title={managedCopyHere.claim.severalTitle(boxes.length)}
      sub={managedCopyHere.claim.severalSub}
      tip={managedCopyHere.claim.tip}
      back={backToList(onBack)}
    >
      <Card>
        {boxes.map((b, i) => (
          <Row
            key={b.device}
            first={i === 0}
            dot="ok"
            dotLabel={managedCopyHere.appliances.online}
            title={modelLabel(b.model)}
            meta={b.device}
            action={
              <Button
                label={managedCopyHere.claim.pick}
                variant="secondary"
                onPress={() => onPick(b)}
                accessibilityHint={managedCopyHere.claim.pickLabel(modelLabel(b.model), b.device)}
              />
            }
          />
        ))}
      </Card>
      <Button label={managedCopyHere.claim.noneOfThese} variant="quiet" onPress={onNone} />
      <Button label={managedCopyHere.claim.withCard} variant="quiet" onPress={onCard} />
    </Frame>
  );
}

/**
 * No box found on this network, or not this one (CC-13): the phone has to be on the Whombat's network. “Look again”
 * asks `claims.nearby` again; the card stays the way for a box without a screen.
 */
export function ClaimNoneScreen({
  onLookAgain,
  onCard,
  onBack,
}: {
  onLookAgain: () => void;
  onCard: () => void;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Frame
      kicker={managedCopyHere.claim.kicker}
      title={managedCopyHere.claim.noneTitle}
      sub={managedCopyHere.claim.noneSub}
      tip={managedCopyHere.claim.tip}
      back={backToList(onBack)}
    >
      <Button label={managedCopyHere.claim.lookAgain} size="lg" onPress={onLookAgain} />
      <Button label={managedCopyHere.claim.withCard} variant="quiet" onPress={onCard} />
    </Frame>
  );
}

/** The factory card, for a box without a screen (CC-02): scanned, or typed. */
export function ClaimCardScreen({
  initial,
  askName,
  busy,
  error,
  onClaim,
  onBack,
  onCode,
}: ClaimScreenProps & { initial?: ClaimCard | null; onCode: () => void }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const [device, setDevice] = useState(initial?.device ?? '');
  const [secret, setSecret] = useState(initial?.secret ?? '');
  const [name, setName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const ready = agreed && device.trim() && secret.trim() && (!askName || name.trim());
  return (
    <Frame
      kicker={managedCopyHere.claim.kicker}
      title={managedCopyHere.claim.cardTitle}
      sub={managedCopyHere.claim.cardSub}
      tip={managedCopyHere.claim.cardTip}
      back={backToList(onBack)}
    >
      <Button
        label={managedCopyHere.claim.scan}
        variant="secondary"
        size="lg"
        onPress={() => setScanning(true)}
      />
      <Note text={note} />
      <ErrorLine text={scanError} />
      <Field
        label={managedCopyHere.claim.device}
        value={device}
        onChangeText={setDevice}
        mono
        placeholder={managedCopyHere.claim.devicePlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={managedCopyHere.claim.secret}
        value={secret}
        onChangeText={setSecret}
        mono
        placeholder={managedCopyHere.claim.secretPlaceholder}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
      />
      {askName ? <NameField value={name} onChange={setName} /> : null}
      <TermsCheck checked={agreed} onChange={setAgreed} />
      <ErrorLine text={error} />
      <Button
        label={busy ? managedCopyHere.claim.claiming : managedCopyHere.claim.claim}
        size="lg"
        busy={busy}
        disabled={!ready}
        onPress={() =>
          onClaim(
            { method: 'card', device: device.trim(), secret: normalizeClaimSecret(secret) },
            name.trim(),
          )
        }
      />
      <Button label={managedCopyHere.claim.withCode} variant="quiet" onPress={onCode} />
      <QrScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onDenied={() => {
          setScanning(false);
          setScanError(managedCopyHere.claim.scanDenied);
        }}
        onScanned={(text) => {
          const card = parseClaimQr(text);
          if (!card) return managedCopyHere.claim.scanWrong;
          setDevice(card.device);
          setSecret(card.secret);
          setScanning(false);
          setScanError(null);
          setNote(managedCopyHere.claim.scanned);
          return null;
        }}
      />
    </Frame>
  );
}

/* Recovery kit -------------------------------------------------------------------------------------------- */

/** Saves the kit's text through the share sheet (Files, a drive, print) and deletes the temporary file after. */
export interface KitSaver {
  save(fileName: string, text: string): Promise<void>;
  /** Removes any copy the app wrote for the share sheet. */
  discard(): void;
}

/**
 * The recovery kit made from This Whombat (BX-01): registered with the Whombat (or, when it has one, signed by the
 * current kit's key), then kept the ways the person ticks (`KitWays`: their passkey, a print, a file;
 * backup-options-android.md AP-6854).
 */
export function RecoveryKitScreen({
  session,
  applianceName,
  device,
  appliancePeerId,
  saver,
  printer,
  control,
  platform,
  onDone,
  onBack,
}: {
  session: ApplianceSession;
  applianceName: string;
  device: string;
  appliancePeerId: string;
  saver: KitSaver;
  printer: KitPrinter;
  control: ControlApi | null;
  platform: PasskeyPlatform | null;
  onDone: () => void;
  /** Reached from This Whombat (a new kit, BX-01): a way back. */
  onBack?: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const [kit] = useState<RecoveryKit>(() => newRecoveryKit({ applianceName, device, appliancePeerId }));
  const [registered, setRegistered] = useState<{ kitId: string; challenge: string } | null>(null);
  /** The kit's backup section: undefined while it's asked for (the kit waits for it), null: none set up (AP-265). */
  const [backup, setBackup] = useState<KitBackup | KitBackupGap | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A kit exists already: the current key must sign the new one (`recovery.kit.rotate`, CT-45). */
  const [rotate, setRotate] = useState(false);
  const [current, setCurrent] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // With backups set up, the kit also carries what restoring them needs (none yet is fine). What this
    // app can't write whole is left out and said so (AP-265).
    void loadKitBackup(session).then(setBackup);
    const register = () =>
      sessionOps
        .recoveryKitRegister(session, kit.publicKeyHex)
        .then((r) => setRegistered({ kitId: r.kitId, challenge: r.challenge }))
        .catch((e: unknown) => {
          if (e instanceof OperationError && e.code === 'recovery_key_exists') setRotate(true);
          else setError(managedCopyHere.claim.errors.failed);
        });
    sessionOps.applianceStatus(session).then(
      (s) => (s.recovery.enrolled && s.recovery.kitVerified ? setRotate(true) : void register()),
      () => void register(),
    );
  }, [session, kit, managedCopyHere.claim.errors.failed]);

  const rotateKit = async () => {
    const secret = recoverySecretFromKey(current);
    if (!secret) {
      setError(managedCopyHere.claim.errors.recovery_rotation_invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await sessionOps.recoveryKitRotate(session, {
        newRecoveryPublicKey: kit.publicKeyHex,
        currentKeySignature: rotationSignature({
          currentSecretKeyHex: secret,
          appliancePeerId,
          newRecoveryPublicKey: kit.publicKeyHex,
        }),
      });
      setCurrent('');
      setRotate(false);
      setRegistered({ kitId: r.kitId, challenge: r.challenge });
    } catch (err) {
      setError(
        err instanceof OperationError && err.code === 'recovery_rotation_invalid'
          ? managedCopyHere.claim.errors.recovery_rotation_invalid
          : managedCopyHere.claim.errors.failed,
      );
    } finally {
      setBusy(false);
    }
  };

  // The kit's temporary file never outlives this screen.
  useEffect(() => () => saver.discard(), [saver]);

  if (rotate && !registered)
    return (
      <Frame
        kicker={managedCopyHere.kit.kicker}
        title={managedCopyHere.kit.rotateTitle}
        sub={managedCopyHere.kit.rotateSub}
        tip={managedCopyHere.kit.tip}
        {...(onBack ? { back: { label: 'Back', onPress: onBack } } : {})}
      >
        <Field
          label={managedCopyHere.kit.currentKey}
          value={current}
          onChangeText={setCurrent}
          mono
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          multiline
        />
        <ErrorLine text={error} />
        <Button
          label={managedCopyHere.kit.rotate}
          size="lg"
          busy={busy}
          disabled={!current.trim()}
          onPress={() => void rotateKit()}
        />
      </Frame>
    );

  return (
    <>
      {isKitBackupGap(backup) ? <Note text={kitBackupText(rawLocale)[backup.gap]} /> : null}
      <KitWays
        session={session}
        applianceName={applianceName}
        device={device}
        appliancePeerId={appliancePeerId}
        kit={kit}
        registered={registered}
        backup={isKitBackupGap(backup) ? null : backup}
        saver={saver}
        printer={printer}
        control={control}
        platform={platform}
        onDone={onDone}
        {...(onBack ? { onBack } : {})}
      />
    </>
  );
}

/* Pairing ------------------------------------------------------------------------------------------------- */

export function PairScreen({
  session,
  label,
  platform,
  fingerprint,
  onApproved,
  onBack,
  onRecover,
  onPhoneLink,
  onScreen,
}: {
  session: ApplianceSession;
  label: string;
  platform: 'android' | 'ios';
  /** This phone's pairing fingerprint (`pairingFingerprint(own PeerId)`, CT-46): the approver sees the same. */
  fingerprint: string;
  onApproved: (accountId: string | null) => void;
  onBack: () => void;
  /** Lost every signed-in device: the recovery kit instead (AP-41). */
  onRecover?: () => void;
  /** The easy path (AP-534): the computer's QR code, which signs in and lets this phone in with one confirmation. */
  onPhoneLink?: (link: PhoneSignInLink) => void;
  /** At the box (BX-02): its screen shows a code for this phone (the screen flow). */
  onScreen?: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const theme = useTheme();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ pairingId: string; code: string } | null>(null);
  const [state, setState] = useState<'pending' | 'denied' | 'expired' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approved = useRef(onApproved);
  approved.current = onApproved;

  useEffect(() => {
    if (!request) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!live) return;
      try {
        const s = await sessionOps.pairStatus(session, request.pairingId);
        if (!live) return;
        if (s.state === 'approved') {
          approved.current(s.enrolled?.accountId ?? null);
          return;
        }
        setState(s.state);
        if (s.state === 'pending') timer = setTimeout(poll, 1500);
      } catch {
        if (live) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [request, session]);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await sessionOps.pairRequest(session, { endpoint: { label, platform } });
      setRequest({ pairingId: r.pairingId, code: r.code });
      setState('pending');
    } catch {
      setError(managedCopyHere.claim.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame
      kicker={managedCopyHere.pair.kicker}
      title={managedCopyHere.pair.title}
      sub={managedCopyHere.pair.sub}
      tip={managedCopyHere.pair.tip}
      back={{ label: managedCopyHere.appliances.title, onPress: onBack }}
    >
      {request && state === 'pending' ? (
        <View style={{ gap: 8 }}>
          <Text
            size={11}
            weight={500}
            mono
            tracking={0.05}
            color={theme.colors.mut}
            style={{ paddingHorizontal: 6 }}
          >
            {managedCopyHere.pair.code}
          </Text>
          <Text
            size={36}
            mono
            weight={500}
            tracking={0.06}
            style={{ paddingHorizontal: 6 }}
            accessibilityLabel={`${managedCopyHere.pair.code}: ${request.code.split('').join(' ')}`}
            testID="pairing-code"
          >
            {request.code}
          </Text>
          <Text
            size={11}
            weight={500}
            mono
            tracking={0.05}
            color={theme.colors.mut}
            style={{ paddingHorizontal: 6, paddingTop: 8 }}
          >
            {managedCopyHere.pair.fingerprint}
          </Text>
          <Text
            size={20}
            mono
            weight={500}
            tracking={0.06}
            style={{ paddingHorizontal: 6 }}
            accessibilityLabel={`${managedCopyHere.pair.fingerprint}: ${fingerprint.split('').join(' ')}`}
            testID="pairing-fingerprint"
          >
            {fingerprint}
          </Text>
          <Note text={managedCopyHere.pair.fingerprintHelp} />
          <Note text={managedCopyHere.pair.waiting} />
        </View>
      ) : (
        <>
          {onPhoneLink ? (
            <>
              <ScanButton
                label={managedCopyHere.phone.pairScan}
                onPress={() => {
                  setScanError(null);
                  setScanning(true);
                }}
              />
              <Note text={managedCopyHere.phone.pairScanHint} />
              <ErrorLine text={scanError} />
              {onScreen ? <ScreenWayRow onUse={onScreen} /> : null}
              <OrDivider label={managedCopyHere.phone.pairOr} />
              <PhoneScanner
                visible={scanning}
                onClose={() => setScanning(false)}
                onDenied={() => {
                  setScanning(false);
                  setScanError(managedCopyHere.phone.scanDeniedSignedIn);
                }}
                onLink={(link) => {
                  setScanning(false);
                  onPhoneLink(link);
                }}
                escapeLabel={managedCopyHere.pair.start}
                onEscape={() => setScanning(false)}
              />
            </>
          ) : onScreen ? (
            <ScreenWayRow onUse={onScreen} />
          ) : null}
          <ErrorLine
            text={
              error ??
              (state === 'denied'
                ? managedCopyHere.pair.denied
                : state === 'expired'
                  ? managedCopyHere.pair.expired
                  : null)
            }
          />
          <Button
            label={managedCopyHere.pair.start}
            size="lg"
            variant={onPhoneLink ? 'secondary' : 'primary'}
            busy={busy}
            onPress={() => void start()}
          />
          {onRecover ? (
            <Button label={managedCopyHere.pair.recover} variant="quiet" onPress={onRecover} />
          ) : null}
          <Note text={managedCopyHere.pair.noDevice} />
        </>
      )}
    </Frame>
  );
}

/* Recovery with the kit (AP-41) ---------------------------------------------------------------------------- */

/** Picks the saved kit file (the share sheet's Files, a drive…); null when the person cancels. */
export type KitPicker = () => Promise<{ name: string; text: string } | null>;

/** What the person gave: the kit file (it may name the Whombat's identity) or the typed recovery key. */
export interface KitInput {
  secretKeyHex: string;
  accountId: string;
  kit: SavedKit | null;
}

export function RecoverScreen({
  device,
  knownAccountId,
  pickKit,
  onSubmit,
  onBack,
}: {
  device: string;
  /** The account this phone had there, if it remembers (a kit file names it too). */
  knownAccountId: string | null;
  pickKit: KitPicker;
  /**
   * Checks the kit against this phone's pin and the directory, then lets this phone in over an enrollment session
   * opened only now (AP-65). Answers the words of a refusal, or null (done, or the flow shows a hard stop).
   */
  onSubmit: (input: KitInput) => Promise<string | null>;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const [file, setFile] = useState<{ name: string; kit: SavedKit } | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setError(null);
    try {
      const picked = await pickKit();
      if (!picked) return;
      const read = readKitFile(picked.text);
      if (!read.ok)
        return setError(
          read.reason === 'damaged' ? managedCopyHere.recover.damaged : managedCopyHere.recover.notAKit,
        );
      if (read.kit.device && read.kit.device !== device)
        return setError(managedCopyHere.recover.otherWhombat);
      setFile({ name: picked.name, kit: read.kit });
    } catch {
      setError(managedCopyHere.recover.notAKit);
    }
  };

  const submit = async () => {
    setError(null);
    const secretKeyHex = file?.kit.secretKeyHex ?? recoverySecretFromKey(typed);
    if (!secretKeyHex) return setError(managedCopyHere.recover.badKey);
    const accountId = file?.kit.accountId ?? knownAccountId;
    if (!accountId) return setError(managedCopyHere.recover.whoUnknown);
    setBusy(true);
    const refused = await onSubmit({ secretKeyHex, accountId, kit: file?.kit ?? null });
    if (refused) {
      setError(refused);
      setBusy(false);
    }
  };

  return (
    <Frame
      kicker={managedCopyHere.recover.kicker}
      title={managedCopyHere.recover.title}
      sub={managedCopyHere.recover.sub}
      tip={managedCopyHere.recover.tip}
      back={{ label: managedCopyHere.appliances.title, onPress: onBack }}
    >
      <Button label={managedCopyHere.recover.openFile} variant="secondary" onPress={() => void open()} />
      {file ? (
        <Note text={managedCopyHere.recover.opened(file.name)} />
      ) : (
        <Field
          label={managedCopyHere.recover.key}
          value={typed}
          onChangeText={setTyped}
          mono
          placeholder={managedCopyHere.recover.keyPlaceholder}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
        />
      )}
      <ErrorLine text={error} />
      <Button
        label={busy ? managedCopyHere.recover.working : managedCopyHere.recover.go}
        size="lg"
        busy={busy}
        disabled={!file && !typed.trim()}
        onPress={() => void submit()}
      />
    </Frame>
  );
}

/* Deleting the cloud account (CT-78, AP-73) --------------------------------------------------------------- */

export function DeleteAccountScreen({
  email,
  onDelete,
  onBack,
}: {
  email: string;
  /** Deletes the account; answers the words of a refusal, or null once it's gone. */
  onDelete: (typed: string) => Promise<string | null>;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const t = managedCopyHere.account;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    const refused = await onDelete(typed.trim());
    if (refused) {
      setError(refused);
      setBusy(false);
    }
  };
  return (
    <Frame
      kicker={t.kicker}
      title={t.title}
      sub={t.sub}
      tip={t.tip}
      back={{ label: managedCopyHere.appliances.title, onPress: onBack }}
    >
      <Card label={t.deleted}>
        {t.deletedItems.map((item, i) => (
          <Row key={item} first={i === 0} title={item} />
        ))}
      </Card>
      <Card label={t.kept}>
        {t.keptItems.map((item, i) => (
          <Row key={item} first={i === 0} title={item} />
        ))}
      </Card>
      <Field
        label={t.email}
        hint={email}
        value={typed}
        onChangeText={setTyped}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      <ErrorLine text={error} />
      <Button
        label={busy ? t.deleting : t.go}
        size="lg"
        busy={busy}
        disabled={!matches}
        onPress={() => void submit()}
      />
    </Frame>
  );
}

/* Setting up a phone that doesn't know this Whombat yet (AP-64) ---------------------------------------------- */

export function SetupScreen({
  onLink,
  onKit,
  onBack,
  onPasskey,
  onScreen,
}: {
  onLink: (link: SetupLink) => void;
  onKit: () => void;
  onBack: () => void;
  /** A passkey made for this Whombat on another device (PK-04); absent without Credential Manager. */
  onPasskey?: () => Promise<void>;
  /** At the box (BX-02): its screen shows a code for this phone (the screen flow). */
  onScreen?: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const t = managedCopyHere.setup;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ways = [
    ...(onPasskey ? [PASSKEY_COPY.setupWay] : []),
    ...(onScreen ? [managedCopyHere.screen.way] : []),
    ...t.ways,
  ];
  return (
    <Frame
      kicker={t.kicker}
      title={t.title}
      sub={t.sub}
      tip={t.tip}
      back={{ label: managedCopyHere.appliances.title, onPress: onBack }}
    >
      <Card>
        {ways.map((way, i) => (
          <Row key={way} first={i === 0} title={way} />
        ))}
      </Card>
      {onPasskey ? (
        <PasskeyButton onPasskey={onPasskey} onError={setError} label={PASSKEY_COPY.setupUse} />
      ) : null}
      {onScreen ? (
        <Button label={managedCopyHere.screen.use} variant="secondary" size="lg" onPress={onScreen} />
      ) : null}
      <Field
        label={t.paste}
        hint={t.pasteHint}
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      <ErrorLine text={error} />
      <Button
        label={t.go}
        size="lg"
        disabled={!text.trim()}
        onPress={() => {
          const link = parseSetupLink(text, UI_ORIGINS);
          setError(link ? null : t.badLink);
          if (link) onLink(link);
        }}
      />
      <Button label={t.kit} variant="secondary" onPress={onKit} />
    </Frame>
  );
}

/* The hard stop (AP-64): the identity this phone pinned, a link or a kit disagrees with the directory ------------ */

/** `code`: the computer's sign-in QR code names another identity than the directory (AP-533). */
export type IdentityStop = 'changed' | 'link' | 'kit' | 'code';

export function IdentityStopScreen({
  stop,
  onBack,
  onForget,
}: {
  stop: IdentityStop;
  onBack: () => void;
  /** Removes this phone's record of the Whombat (only offered when there is one). */
  onForget?: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const t = managedCopyHere.identity;
  const [title, text] =
    stop === 'changed'
      ? [t.changedTitle, t.changed]
      : stop === 'link'
        ? [t.linkTitle, t.link]
        : stop === 'code'
          ? [managedCopyHere.phone.codeMismatchTitle, managedCopyHere.phone.codeMismatch]
          : [t.kitTitle, t.kit];
  return (
    <GateScreen
      title={title}
      text={text}
      actions={
        <>
          <Button label={managedCopyHere.connection.back} size="lg" onPress={onBack} />
          {onForget ? (
            <Button
              label={t.forget}
              variant="secondary"
              size="lg"
              onPress={() =>
                Alert.alert(t.forget, t.forgetConfirm, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: t.forget, style: 'destructive', onPress: onForget },
                ])
              }
            />
          ) : null}
        </>
      }
    />
  );
}

/* Passkeys (PK-04) -------------------------------------------------------------------------------------------- */

/** While a passkey opens the Whombat: the sign-in frame, nothing to do. */
export function PasskeyProgressScreen({ name }: { name: string | null }) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Frame
      kicker={managedCopyHere.signIn.kicker}
      title={PASSKEY_COPY.opening(name)}
      sub={PASSKEY_COPY.openingText}
    >
      <Loading />
    </Frame>
  );
}

/** Signed in, not let in (the Whombat needs an update or refused the passkey): set up another way, or the list. */
export function PasskeyStopScreen({
  text,
  onOtherWay,
  onBack,
}: {
  text: string;
  onOtherWay: () => void;
  onBack: () => void;
}) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <GateScreen
      title={managedCopyHere.setup.title}
      text={text}
      actions={
        <>
          <Button label={PASSKEY_COPY.otherWay} size="lg" onPress={onOtherWay} />
          <Button label={managedCopyHere.connection.back} variant="secondary" size="lg" onPress={onBack} />
        </>
      }
    />
  );
}

/* Terminal states ----------------------------------------------------------------------------------------- */

export function GateScreen({ title, text, actions }: { title: string; text: string; actions?: ReactNode }) {
  return (
    <Frame kicker="WHOMBAT" title={title} sub={text}>
      {actions}
    </Frame>
  );
}
