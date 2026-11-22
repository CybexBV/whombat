/**
 * Where a managed Whombat's backups go, on the phone (AP-260; the web's `BackupDestination`, contracts 0.22 CT-142):
 * the kinds as radio rows (44dp, TalkBack says which is chosen), then the kind's fields — an S3-compatible bucket, an
 * SFTP server or NAS (this Whombat's key to add to the server, shared through the share sheet), a restic REST server,
 * a disk labelled `WHOMBAT-BACKUP`. Used by This Whombat → BACKUPS. The words and the repository they make are
 * `@whombat/client/managed`'s, the same as the web's.
 */
import {
  ACCOUNTS_TEXT,
  BACKUP_SETUP_TEXT,
  type BackupForm,
  type BackupKind,
  backupErrorText,
  destinationInput,
  emptyBackupForm,
  MANAGED_TEXT,
} from '@whombat/client/managed';
import { type ApplianceSession, type BackupDestinationResult, sessionOps } from '@whombat/client/session';
import { type ReactNode, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { ErrorLine, Field, Note } from './ui';

const T = BACKUP_SETUP_TEXT;

export { backupErrorText };

/** What you are told after saving: whether old backups are safe from this box, and the host key to compare. */
export function savedNotes(result: BackupDestinationResult): string[] {
  return [
    ACCOUNTS_TEXT.appendOnly[result.appendOnly] ?? null,
    result.hostKeyFingerprint ? T.hostKeyPinned(result.hostKeyFingerprint) : null,
  ].filter((n): n is string => n !== null);
}

export function BackupDestinationForm({
  session,
  kinds,
  onSaved,
  extraActions,
}: {
  session: ApplianceSession;
  kinds: readonly BackupKind[];
  onSaved: (result: BackupDestinationResult) => void;
  extraActions?: ReactNode;
}) {
  const [form, setForm] = useState<BackupForm>(() => emptyBackupForm(kinds[0] ?? 'rest'));
  const [invalid, setInvalid] = useState<{ field: keyof BackupForm; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = kinds.includes(form.kind) ? form.kind : (kinds[0] ?? 'rest');

  const set = (patch: Partial<BackupForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setInvalid(null);
    setError(null);
  };

  const save = async () => {
    const check = destinationInput({ ...form, kind });
    if (!check.ok) {
      setInvalid({ field: check.field, error: check.error });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await sessionOps.backupConfigure(session, check.input);
      setForm(emptyBackupForm(kind));
      onSaved(result);
    } catch (err) {
      setError(backupErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: keyof BackupForm,
    label: string,
    options: {
      secret?: boolean;
      placeholder?: string;
      hint?: string;
      mono?: boolean;
      numeric?: boolean;
    } = {},
  ) => (
    <View style={{ gap: 4 }}>
      <Field
        label={label}
        value={form[name]}
        onChangeText={(v) => set({ [name]: v })}
        mono={options.mono}
        {...(options.placeholder ? { placeholder: options.placeholder } : {})}
        {...(options.hint && invalid?.field !== name ? { hint: options.hint } : {})}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry={options.secret}
        keyboardType={options.numeric ? 'number-pad' : 'default'}
      />
      {invalid?.field === name ? <ErrorLine text={invalid.error} /> : null}
    </View>
  );

  return (
    <View style={{ gap: 14 }}>
      {kinds.length > 1 ? (
        <KindPicker kinds={kinds} kind={kind} onPick={(k) => set({ kind: k })} />
      ) : (
        <Note text={T.onlyRest} />
      )}
      {kind === 's3' ? (
        <>
          {field('s3Endpoint', T.s3Endpoint, { placeholder: T.s3EndpointPlaceholder, mono: true })}
          {field('s3Bucket', T.s3Bucket, { mono: true })}
          {field('s3Folder', T.s3Folder, { mono: true })}
          {field('s3AccessKeyId', T.s3AccessKeyId, { mono: true })}
          {field('s3SecretAccessKey', T.s3SecretAccessKey, { secret: true })}
          {field('s3Region', T.s3Region, { mono: true, hint: T.s3Hint })}
        </>
      ) : null}
      {kind === 'sftp' ? (
        <>
          {/* The box's key first: you add it on the server before Save checks the connection (BK-19). */}
          <SshKey session={session} />
          {field('sftpHost', T.sftpHost, { placeholder: T.sftpHostPlaceholder, mono: true })}
          {field('sftpPort', T.sftpPort, { placeholder: '22', mono: true, numeric: true })}
          {field('sftpPath', T.sftpPath, { placeholder: T.sftpPathPlaceholder, mono: true })}
          {field('sftpUser', T.sftpUser, { mono: true })}
          {field('sftpHostKey', T.sftpHostKey, { mono: true, hint: T.sftpHostKeyHint })}
        </>
      ) : null}
      {kind === 'rest' ? (
        <>
          {field('restRepository', T.restRepository, {
            placeholder: T.restRepositoryPlaceholder,
            mono: true,
            hint: T.restHint,
          })}
          {field('restUser', T.restUser)}
          {field('restPassword', T.restPassword, { secret: true })}
        </>
      ) : null}
      {kind === 'disk' ? <Note text={T.diskHelp} /> : null}
      {field('adoptPassword', T.adopt, { secret: true })}
      <ErrorLine text={error} />
      <Button label={busy ? T.saving : T.save} size="lg" busy={busy} onPress={() => void save()} />
      {extraActions}
    </View>
  );
}

function KindPicker({
  kinds,
  kind,
  onPick,
}: {
  kinds: readonly BackupKind[];
  kind: BackupKind;
  onPick: (k: BackupKind) => void;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={T.kindLegend} style={{ gap: 8 }}>
      {kinds.map((k) => {
        const on = k === kind;
        return (
          <Touchable
            key={k}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${T.kinds[k].title}. ${T.kinds[k].meta}`}
            onPress={() => onPick(k)}
            ringRadius={14}
            style={{
              flexDirection: 'row',
              gap: 12,
              minHeight: 56,
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderRadius: 14,
              borderWidth: 1.5,
              borderColor: on ? theme.colors.ink : theme.colors.line,
              backgroundColor: theme.colors.sf,
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                marginTop: 2,
                borderRadius: 9,
                borderWidth: on ? 5 : 1.5,
                borderColor: on ? theme.colors.btn : theme.colors.line2,
              }}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={15} weight={600}>
                {T.kinds[k].title}
              </Text>
              <Text size={13} lh={1.4} color={theme.colors.ink2}>
                {T.kinds[k].meta}
              </Text>
            </View>
          </Touchable>
        );
      })}
    </View>
  );
}

/** This Whombat's SFTP key (`backup.sshPublicKey`), to add to the server; shared through the share sheet. */
function SshKey({ session }: { session: ApplianceSession }) {
  const theme = useTheme();
  const [key, setKey] = useState<{ publicKey: string; fingerprint: string } | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again
  useEffect(() => {
    let live = true;
    setKey(null);
    sessionOps.backupSshPublicKey(session).then(
      (k) => live && setKey(k),
      () => live && setKey('failed'),
    );
    return () => {
      live = false;
    };
  }, [session, attempt]);
  return (
    <View
      style={{
        gap: 8,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf2,
      }}
    >
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
        {T.sftpKeyLabel}
      </Text>
      {key === null ? (
        <Note text={T.sftpKeyLoading} />
      ) : key === 'failed' ? (
        <>
          <Note text={T.sftpKeyFailed} />
          <Button label={MANAGED_TEXT.retry} variant="secondary" onPress={() => setAttempt((n) => n + 1)} />
        </>
      ) : (
        <>
          <Note text={T.sftpKeyHelp} />
          <Text size={12.5} mono lh={1.5} selectable>
            {key.publicKey}
          </Text>
          <Text size={12} mono color={theme.colors.mut}>
            {T.sftpKeyFingerprint(key.fingerprint)}
          </Text>
          <Button
            label={T.shareKey}
            variant="secondary"
            onPress={() => void Share.share({ message: key.publicKey }).catch(() => {})}
          />
        </>
      )}
    </View>
  );
}
