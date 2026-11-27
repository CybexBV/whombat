/**
 * “Keep a way back in” on the phone (Whombat backup-options.md BKO-09; backup-options-android.md AP-6854…AP-6858): three
 * checkboxes — Your passkey (recommended, ticked; only where a prompt can carry PRF), Print it too (ticked), Save as a
 * file — and one button that does what is ticked: locks the kit with this Whombat's passkey (adding one first when the
 * account has none for it) and keeps the envelope at control, shares the print page, shares the file. A locked kit is
 * confirmed at once (`recovery.kit.confirm`); a printed or saved one after “I’ve saved the kit”, as before.
 */

import {
  accountOf,
  backupOptionsText,
  type ControlApi,
  confirmationSignature,
  type KitBackup,
  kitQrPayload,
  kitText,
  lockKitWithPasskey,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  passkeyErrorText,
  passkeyName,
  type RecoveryKit,
  setUpOnePasskey,
} from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FileIcon, type LucideIcon, Printer, Square, SquareCheck, UserKey } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { Tag } from './BackupsOverview';
import {
  BACKUP_PHONE_TEXT,
  initialKitWays,
  kitPasskeyIds,
  kitPrimary,
  kitPrintHtml,
  type KitWays as Ways,
} from './backupOptions';
import { managedCopy } from './copy';
import { phoneLabel } from './env';
import { ErrorLine, Frame, Note } from './ui';

/** Shares the kit's print page (an HTML file the share sheet hands to a browser or a printer app; AP-6857). */
export interface KitPrinter {
  print(fileName: string, html: string): Promise<void>;
}

export interface KitWaysProps {
  session: ApplianceSession;
  applianceName: string;
  device: string;
  appliancePeerId: string;
  kit: RecoveryKit;
  /** The kit's registration (its id and challenge) once the Whombat answered. */
  registered: { kitId: string; challenge: string } | null;
  /** The kit's backup section; undefined while it's asked for. */
  backup: KitBackup | null | undefined;
  saver: { save(fileName: string, text: string): Promise<void>; discard(): void };
  printer: KitPrinter;
  control: ControlApi | null;
  platform: PasskeyPlatform | null;
  onDone: () => void;
  onBack?: () => void;
}

export function KitWays(props: KitWaysProps) {
  const { rawLocale } = useI18n();
  const K = backupOptionsText(rawLocale).kit;
  const managedCopyHere = managedCopy(rawLocale);

  const { session, control, platform, appliancePeerId } = props;
  const prf = !!platform?.prf && !!control;
  const [ways, setWays] = useState<Ways>(() => initialKitWays(prf));
  /** Whether the account has a passkey for this Whombat at control (null: not known yet). */
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Printed or saved, waiting for “I’ve saved the kit”. */
  const [kept, setKept] = useState(false);

  useEffect(() => {
    if (!prf || !control) return;
    let live = true;
    control.passkeys().then(
      (list) => live && setHasPasskey(kitPasskeyIds(list, appliancePeerId).length > 0),
      () => live && setHasPasskey(null),
    );
    return () => {
      live = false;
    };
  }, [prf, control, appliancePeerId]);

  const ready = !!props.registered && props.backup !== undefined;
  const text = () => kitText(props.kit, props.backup ?? null, accountOf(session));

  const confirm = async () => {
    if (!props.registered) return;
    await sessionOps.recoveryKitConfirm(session, {
      kitId: props.registered.kitId,
      signature: confirmationSignature(props.kit, props.registered.kitId, props.registered.challenge),
    });
    props.saver.discard();
    props.onDone();
  };

  const generationNow = () =>
    sessionOps.backupStatus(session).then(
      (s) => s.status?.kitGeneration ?? 0,
      () => 0,
    );

  /** Locks the kit with the account's passkey, finishing its setup first. */
  const lock = async (kitTextNow: string, generation: number): Promise<boolean> => {
    if (!platform || !control) return false;
    const added = await setUpOnePasskey({
      locale: rawLocale,
      session,
      control,
      platform,
      appliance: appliancePeerId,
      me: accountOf(session),
      name: passkeyName(phoneLabel()),
    });
    const ids = [added.credentialId];
    setHasPasskey(true);
    await lockKitWithPasskey({
      platform,
      control,
      appliance: appliancePeerId,
      credentialIds: ids,
      kitText: kitTextNow,
      generation,
    });
    return true;
  };

  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const t = text();
    try {
      const generation = await generationNow();
      let locked = false;
      if (ways.passkey) {
        try {
          locked = await lock(t, generation);
        } catch (e) {
          if (e instanceof PasskeyCancelled) return;
          setError(
            e instanceof PasskeyError && e.code === 'unsupported'
              ? K.noPrf
              : (passkeyErrorText(e) ?? managedCopyHere.claim.errors.failed),
          );
          return;
        }
      }
      if (ways.print) {
        try {
          await props.printer.print(
            `whombat-recovery-kit-${props.device}.html`,
            kitPrintHtml({
              name: props.applianceName,
              kitText: t,
              qrPayload: kitQrPayload(t),
              locale: rawLocale,
            }),
          );
        } catch {
          setError(BACKUP_PHONE_TEXT.printFailed);
          return;
        }
      }
      if (ways.file) {
        try {
          await props.saver.save(`whombat-recovery-kit-${props.device}.txt`, t);
        } catch {
          setError(BACKUP_PHONE_TEXT.fileFailed);
          return;
        }
      }
      // Locked: the envelope at control proves it is kept. Printed or saved: the person says so.
      if (locked) await confirm();
      else setKept(true);
    } catch {
      setError(managedCopyHere.claim.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const primary = kitPrimary(ways, rawLocale);
  const back = props.onBack ? { back: { label: BACKUP_PHONE_TEXT.back, onPress: props.onBack } } : {};

  if (kept)
    return (
      <Frame kicker={managedCopyHere.kit.kicker} title={K.title} sub={K.lead(props.applianceName)} {...back}>
        <Note text={K.saved} />
        <ErrorLine text={error} />
        <Button
          label={managedCopyHere.kit.confirm}
          size="lg"
          busy={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            confirm()
              .catch(() => setError(managedCopyHere.claim.errors.failed))
              .finally(() => setBusy(false));
          }}
        />
        <Button
          label={managedCopyHere.kit.downloadAgain}
          variant="secondary"
          onPress={() => setKept(false)}
        />
      </Frame>
    );

  return (
    <Frame kicker={managedCopyHere.kit.kicker} title={K.title} sub={K.lead(props.applianceName)} {...back}>
      <WaysCard ways={ways} prf={prf} onChange={setWays} />
      {ways.passkey && hasPasskey === false ? <Note text={K.noPasskey(props.applianceName)} /> : null}
      <ErrorLine text={error} />
      <Button
        label={primary ?? backupOptionsText(rawLocale).dialog.save}
        size="lg"
        busy={busy || (!ready && !error)}
        disabled={!primary || !ready}
        onPress={() => void go()}
      />
    </Frame>
  );
}

function WaysCard({ ways, prf, onChange }: { ways: Ways; prf: boolean; onChange: (w: Ways) => void }) {
  const { rawLocale } = useI18n();
  const K = backupOptionsText(rawLocale).kit;
  const theme = useTheme();
  const rows: { key: keyof Ways; icon: LucideIcon; title: string; meta: string; tag?: string }[] = [
    ...(prf
      ? [
          {
            key: 'passkey' as const,
            icon: UserKey,
            title: K.passkey,
            meta: K.passkeyMeta,
            tag: backupOptionsText(rawLocale).dialog.recommended,
          },
        ]
      : []),
    { key: 'print', icon: Printer, title: K.print, meta: K.printMeta },
    { key: 'file', icon: FileIcon, title: K.file, meta: K.fileMeta },
  ];
  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {rows.map((r, i) => {
        const on = ways[r.key];
        const Box = on ? SquareCheck : Square;
        const Icon = r.icon;
        return (
          <Touchable
            key={r.key}
            feedback="wash"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={[r.title, r.tag, r.meta].filter(Boolean).join('. ')}
            onPress={() => onChange({ ...ways, [r.key]: !on })}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 64,
              paddingVertical: 14,
              paddingHorizontal: 14,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Icon size={20} color={theme.colors.ink2} strokeWidth={1.8} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text size={15.5} weight={600}>
                  {r.title}
                </Text>
                {r.tag ? <Tag text={r.tag} /> : null}
              </View>
              <Text size={13} lh={1.45} color={theme.colors.mut}>
                {r.meta}
              </Text>
            </View>
            <Box size={24} color={on ? theme.colors.btn : theme.colors.line2} strokeWidth={on ? 2.2 : 1.6} />
          </Touchable>
        );
      })}
    </View>
  );
}
