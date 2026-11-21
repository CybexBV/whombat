/**
 * Backup file (managed only; contracts 0.79.0, CT-335; Whombat backup-file.md BF-01…; backup-file-android.md
 * AP-1211…), opened from This Whombat → Backups' BACKUP FILE section (this-whombat-sections-android.md AP-1246) on a
 * Whombat with `backup.file`: the web's two
 * panels (Settings → This Whombat → BACKUP FILE, AP-1181…) one under the other. “Download a backup”: the categories
 * with their lines and sizes, the password, Download (the file is made, then saved through Android's “Save as”, written
 * as it arrives, picking up where the connection dropped), “Make these the default”. “Restore from a file”: choose a
 * `.wbk`, it uploads (going on where a stopped upload of the same file ended), its password, what it holds per
 * category, “When something is different”, Restore, then what came back and what needs you. The hooks are the shared
 * ones (`useBackupMaker`, `useBackupRestorer`); what each step shows is `backupFile.ts`.
 */
import {
  BACKUP_FILE_TEXT,
  type BackupDownloadRow,
  type BackupProgressView,
  type BackupRestoreRow,
} from '@whombat/client';
import { THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import { useBackupMaker, useBackupRestorer } from '@whombat/client/react';
import { BACKUP_COPY, type BackupRestoreChip } from '@whombat/core/backup';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { type AppNavigation, useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Check } from '../ui/icons';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { Button, Skeleton } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import {
  type BackupFileCard,
  backupDownloadPanel,
  backupLeaveQuestion,
  backupRestorePanel,
  downloadRowLabel,
  restoreRowLabel,
  storedDismissedRestores,
} from './backupFile';
import { chooseBackupSink, keepScreenOn, pickBackupSource } from './backupFileSave';
import { COPY } from './copy';
import { documentTextFile } from './expoStores';
import { preloadedStorage } from './stores';
import { Card, ErrorLine, Note } from './ui';

const T = COPY.backupFile;

let dismissedStore: ReturnType<typeof storedDismissedRestores> | null = null;
/** The restores put away on this phone, in a small file next to the registry's (AP-1219). */
const dismissedRestores = () => {
  dismissedStore ??= storedDismissedRestores(preloadedStorage(documentTextFile('whombat-backup-file.json')));
  return dismissedStore;
};

export function BackupFileScreen() {
  const navigation = useAppNavigation();
  const { slug, timeZone } = useBurrowBase();
  const back = (
    <BackBar
      label={THIS_WHOMBAT_TEXT.parts.backups}
      onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('WhombatBackups'))}
    />
  );
  return <BackupFilePanels slug={slug} timeZone={timeZone} back={back} navigation={navigation} />;
}

function BackupFilePanels({
  slug,
  timeZone,
  back,
  navigation,
}: {
  slug: string;
  timeZone: string;
  back: ReactNode;
  navigation: AppNavigation;
}) {
  const bottomRoom = useBottomRoom();
  const maker = useBackupMaker(slug);
  const restorer = useBackupRestorer(slug, { dismissed: dismissedRestores() });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Leaving stops a download or an upload: ask first, and keep the screen on while one runs (AP-1215).
  const question = backupLeaveQuestion({
    downloading: maker.download.status === 'downloading',
    uploading: restorer.uploading !== null,
  });
  useLeaveQuestion(navigation, question);
  const moving = question !== null;
  useEffect(() => {
    if (!moving) return;
    keepScreenOn(true);
    return () => keepScreenOn(false);
  }, [moving]);

  const save = async () => {
    const file = maker.file;
    if (!file) return;
    setSaveError(null);
    let sink: Awaited<ReturnType<typeof chooseBackupSink>>;
    try {
      sink = await chooseBackupSink(file.name);
    } catch {
      setSaveError(T.saveFailed);
      return;
    }
    if (sink) await maker.startDownload(sink);
  };

  const choose = async () => {
    setPickError(null);
    let picked: Awaited<ReturnType<typeof pickBackupSource>>;
    try {
      picked = await pickBackupSource();
    } catch {
      setPickError(BACKUP_FILE_TEXT.failed);
      return;
    }
    if (!picked) return;
    if ('problem' in picked) {
      setPickError(picked.problem);
      return;
    }
    try {
      await restorer.choose(picked.source);
    } finally {
      picked.source.close();
    }
  };

  return (
    <Screen>
      {back}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
        >
          <LargeTitle title={T.title} />
          <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 32 }}>
            <DownloadPanel maker={maker} onSave={() => void save()} saveError={saveError} />
            <RestorePanel
              restorer={restorer}
              timeZone={timeZone}
              onChoose={() => void choose()}
              pickError={pickError}
              onLink={(link) =>
                link === 'connections'
                  ? navigation.navigate('Connections')
                  : navigation.navigate('Tabs', { screen: 'Automations' })
              }
              onPointHere={(address) =>
                navigation.navigate('AddServer', { ...(address ? { address } : {}), back: T.title })
              }
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** Asks before the screen goes while a file moves (the web's tab would stop it the same way). */
function useLeaveQuestion(navigation: AppNavigation, question: ReturnType<typeof backupLeaveQuestion>) {
  const ref = useRef(question);
  ref.current = question;
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        const q = ref.current;
        if (!q) return;
        e.preventDefault();
        Alert.alert(q.title, q.text, [
          { text: q.stay, style: 'cancel' },
          { text: q.stop, style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation],
  );
}

/* Download a backup ------------------------------------------------------------------------------------------------ */

function DownloadPanel({
  maker,
  onSave,
  saveError,
}: {
  maker: ReturnType<typeof useBackupMaker>;
  onSave: () => void;
  saveError: string | null;
}) {
  const theme = useTheme();
  const panel = backupDownloadPanel(maker);
  return (
    <View style={{ gap: 14 }}>
      <PanelHead title={BACKUP_COPY.download.title} intro={BACKUP_COPY.download.intro} />
      {panel.step === 'choose' ? (
        <>
          <Card>
            {panel.rows.map((row, i) => (
              <DownloadRow
                key={row.id}
                row={row}
                first={i === 0}
                loading={maker.loading}
                onPress={() => maker.toggle(row.id)}
              />
            ))}
          </Card>
          <FormField
            label={BACKUP_COPY.download.passwordLabel}
            value={maker.password}
            onChangeText={maker.setPassword}
            secret
            error={panel.passwordError}
            hint={BACKUP_COPY.download.passwordHint}
            returnKeyType="go"
            onSubmitEditing={() => void maker.make()}
          />
          <Button label={panel.make.label} busy={panel.make.busy} onPress={() => void maker.make()} />
          {panel.defaults.offer ? (
            <Button
              label={BACKUP_COPY.download.makeDefault}
              variant="secondary"
              busy={panel.defaults.saving}
              onPress={() => void maker.defaults.save()}
            />
          ) : null}
          <Note text={panel.defaults.saved} />
          {panel.notes.map((note) => (
            <ErrorLine key={note} text={note} />
          ))}
        </>
      ) : panel.step === 'making' ? (
        <>
          <FileCard file={panel.file} />
          <Button
            label={panel.cancel.label}
            variant="secondary"
            busy={panel.cancel.busy}
            onPress={() => void maker.remove()}
          />
          <ErrorLine text={panel.error} />
        </>
      ) : (
        <>
          <Text size={15.5} weight={600} style={{ paddingHorizontal: 6 }} accessibilityLiveRegion="polite">
            {panel.title}
          </Text>
          <FileCard file={panel.file} />
          {panel.transfer ? (
            <>
              <ProgressBar progress={panel.transfer} />
              <Note text={T.stay} />
            </>
          ) : null}
          {panel.saved ? (
            <Text size={14} lh={1.45} color={theme.colors.ok} accessibilityLiveRegion="polite">
              {panel.saved}
            </Text>
          ) : null}
          <ErrorLine text={panel.error ?? saveError} />
          {panel.save ? (
            <Button
              label={panel.save.label}
              variant={panel.save.primary ? 'primary' : 'secondary'}
              onPress={onSave}
            />
          ) : (
            <Button label={BACKUP_COPY.restore.cancel} variant="secondary" onPress={maker.cancelDownload} />
          )}
          <Button
            label={panel.remove.label}
            variant="secondary"
            busy={panel.remove.busy}
            disabled={panel.remove.disabled}
            onPress={() => void maker.remove()}
          />
        </>
      )}
    </View>
  );
}

/** A category to tick: the box, its label and size, the plain line under it (one TalkBack checkbox). */
function DownloadRow({
  row,
  first,
  loading,
  onPress,
}: {
  row: BackupDownloadRow;
  first: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="checkbox"
      accessibilityState={{ checked: row.ticked }}
      accessibilityLabel={downloadRowLabel(row)}
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Tick on={row.ticked} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text size={15.5} weight={600} lh={1.3} style={{ flex: 1 }}>
            {row.label}
          </Text>
          {row.size ? (
            <Text size={12} mono color={theme.colors.mut}>
              {row.size}
            </Text>
          ) : null}
        </View>
        {row.meta ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {row.meta}
          </Text>
        ) : loading ? (
          <Skeleton width="60%" height={11} style={{ marginTop: 4 }} />
        ) : null}
      </View>
    </Touchable>
  );
}

/* Restore from a file ---------------------------------------------------------------------------------------------- */

function RestorePanel({
  restorer,
  timeZone,
  onChoose,
  pickError,
  onLink,
  onPointHere,
}: {
  restorer: ReturnType<typeof useBackupRestorer>;
  timeZone: string;
  onChoose: () => void;
  pickError: string | null;
  onLink: (link: 'connections' | 'automations') => void;
  /** “Point it here”: Add a server, filled in with the server's address (AP-4420). */
  onPointHere: (address: string | null) => void;
}) {
  const theme = useTheme();
  const panel = backupRestorePanel(restorer, timeZone);
  const cancel = (busy: boolean) => (
    <Button
      label={BACKUP_COPY.restore.cancel}
      variant="secondary"
      busy={busy}
      onPress={() => void restorer.cancel()}
    />
  );
  return (
    <View style={{ gap: 14 }}>
      <PanelHead title={BACKUP_COPY.restore.title} intro={BACKUP_COPY.restore.intro} />
      {panel.step === 'choose' ? (
        <>
          {panel.stopped ? <FileCard file={panel.stopped} /> : null}
          <ErrorLine text={panel.error ?? pickError} />
          <Button label={panel.choose.label} onPress={onChoose} />
        </>
      ) : panel.step === 'uploading' ? (
        <>
          <FileCard file={panel.file} />
          <Note text={T.stay} />
          {cancel(panel.cancel.busy)}
        </>
      ) : panel.step === 'password' ? (
        <>
          <FileCard file={panel.file} />
          <FormField
            label={BACKUP_COPY.restore.passwordLabel}
            value={restorer.password}
            onChangeText={restorer.setPassword}
            secret
            error={panel.passwordError}
            returnKeyType="go"
            onSubmitEditing={() => void restorer.open()}
          />
          <ErrorLine text={panel.error} />
          <Button
            label={panel.open.label}
            busy={panel.open.busy}
            disabled={panel.open.disabled}
            onPress={() => void restorer.open()}
          />
          {cancel(panel.cancel.busy)}
        </>
      ) : panel.step === 'preview' ? (
        <>
          <FileCard file={panel.file} />
          <Card>
            {panel.rows.map((row, i) => (
              <RestoreRow key={row.id} row={row} first={i === 0} onPress={() => restorer.toggle(row.id)} />
            ))}
          </Card>
          {panel.notes.map((note) => (
            <Note key={note} text={note} />
          ))}
          {panel.address ? (
            <View style={{ gap: 8 }}>
              <Text size={14} lh={1.45} style={{ paddingHorizontal: 6 }}>
                {panel.address.text}
              </Text>
              <Segmented
                label={panel.address.text}
                options={panel.address.options}
                value={panel.address.value}
                onChange={(v) => restorer.setPointHere(v === 'here')}
              />
            </View>
          ) : null}
          {panel.different.show ? (
            <View style={{ gap: 8 }}>
              <Text size={14} weight={600} style={{ paddingHorizontal: 6 }}>
                {BACKUP_COPY.restore.whenDifferent}
              </Text>
              <Segmented
                label={BACKUP_COPY.restore.whenDifferent}
                options={panel.different.options}
                value={panel.different.value}
                onChange={restorer.setOnDifferent}
              />
            </View>
          ) : null}
          <ErrorLine text={panel.error} />
          <Button
            label={panel.restore.label}
            busy={panel.restore.busy}
            disabled={panel.restore.disabled}
            onPress={() => void restorer.restore()}
          />
          {cancel(panel.cancel.busy)}
        </>
      ) : panel.step === 'restoring' ? (
        <FileCard file={panel.file} />
      ) : (
        <>
          {panel.file ? <FileCard file={panel.file} /> : null}
          <Card>
            <View style={{ padding: 16, gap: 8 }}>
              <Text
                size={16}
                weight={700}
                color={panel.failed ? theme.colors.bad : theme.colors.ink}
                accessibilityLiveRegion="polite"
              >
                {panel.title}
              </Text>
              {panel.lines.map((line) => (
                <Text key={line} size={14} lh={1.45} color={theme.colors.ink2}>
                  {line}
                </Text>
              ))}
            </View>
          </Card>
          {panel.toPoint.length ? (
            <Card>
              {panel.toPoint.map((server, i) => (
                <ServerToPoint
                  key={server.id}
                  server={server}
                  first={i === 0}
                  onPress={() => onPointHere(server.address)}
                />
              ))}
            </Card>
          ) : null}
          {panel.links.map((l) => (
            <Button key={l.link} label={l.label} variant="secondary" onPress={() => onLink(l.link)} />
          ))}
          <Button label={panel.dismiss} variant="secondary" onPress={restorer.dismiss} />
        </>
      )}
    </View>
  );
}

/**
 * A category in the file: the box, its label, the chips (New / Already here / Different), its line and notes. One that
 * can't come back here (the servers, AP-4420) can't be ticked.
 */
function RestoreRow({ row, first, onPress }: { row: BackupRestoreRow; first: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={row.disabled}
      feedback={row.disabled ? 'none' : 'wash'}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: row.ticked, disabled: row.disabled }}
      accessibilityLabel={restoreRowLabel(row)}
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Tick on={row.ticked} />
      <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
        <Text size={15.5} weight={600} lh={1.3} color={row.disabled ? theme.colors.mut : theme.colors.ink}>
          {row.label}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {row.chips.map((chip) => (
            <ChipTag key={chip.label} chip={chip} />
          ))}
        </View>
        {[row.hint, ...row.notes]
          .filter((line): line is string => !!line)
          .map((line) => (
            <Text key={line} size={13} lh={1.4} color={theme.colors.mut}>
              {line}
            </Text>
          ))}
      </View>
    </Touchable>
  );
}

/** A server still looking for the old address: its name and address, and “Point it here” (AP-4420). */
function ServerToPoint({
  server,
  first,
  onPress,
}: {
  server: { name: string; address: string | null; label: string };
  first: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text size={15.5} weight={600} lh={1.3}>
          {server.name}
        </Text>
        {server.address ? (
          <Text size={12} mono color={theme.colors.mut}>
            {server.address}
          </Text>
        ) : null}
      </View>
      <Button
        label={server.label}
        variant="secondary"
        accessibilityLabel={`${server.label}: ${server.name}`}
        onPress={onPress}
      />
    </View>
  );
}

/** “130 new”, “12 already here”, “3 different” (the different one in `warn`, as the mock's amber). */
function ChipTag({ chip }: { chip: BackupRestoreChip }) {
  const theme = useTheme();
  const warn = chip.tone === 'warn';
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: warn ? theme.colors.warn : theme.colors.sf2,
        backgroundColor: theme.colors.sf2,
      }}
    >
      <Text size={12} weight={500} color={warn ? theme.colors.warn : theme.colors.ink2}>
        {chip.label}
      </Text>
    </View>
  );
}

/**
 * A backup file: a `.wbk` mark, its name, one line (and the bar of what moves: making, uploading, restoring). One
 * TalkBack element, a progress bar while something moves.
 */
function FileCard({ file }: { file: BackupFileCard }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={[file.name, file.line].filter(Boolean).join('. ')}
      {...(file.pct !== null && {
        accessibilityRole: 'progressbar' as const,
        accessibilityValue: { min: 0, max: 100, now: file.pct },
      })}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View
        style={{
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: 4,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.sf2,
        }}
      >
        <Text size={11} mono color={theme.colors.mut}>
          .wbk
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text size={15} weight={600} lh={1.3} numberOfLines={2}>
          {file.name}
        </Text>
        {file.line ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {file.line}
          </Text>
        ) : null}
        {file.pct !== null ? <Bar pct={file.pct} /> : null}
      </View>
    </View>
  );
}

/* Parts ------------------------------------------------------------------------------------------------------------ */

function PanelHead({ title, intro }: { title: string; intro: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4, paddingHorizontal: 6 }}>
      <Text size={20} weight={700} tracking={-0.01} lh={1.25} accessibilityRole="header">
        {title}
      </Text>
      <Text size={14.5} lh={1.45} color={theme.colors.mut}>
        {intro}
      </Text>
    </View>
  );
}

/** The mock's checkbox: a 22dp rounded square, filled with a check when ticked (the row is the touch target). */
function Tick({ on }: { on: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 22,
        height: 22,
        marginTop: 1,
        borderRadius: 6,
        borderWidth: on ? 0 : 1.5,
        borderColor: theme.colors.line2,
        backgroundColor: on ? theme.colors.btn : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {on ? <Check size={15} color={theme.colors.btnfg} strokeWidth={2.5} /> : null}
    </View>
  );
}

/** A job's or a transfer's bar with its line (“Making the file · Messages · 42 %”), read as one progress bar. */
function ProgressBar({ progress }: { progress: BackupProgressView }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={progress.text}
      accessibilityValue={{ min: 0, max: 100, now: progress.pct }}
      style={{ gap: 8 }}
    >
      <Bar pct={progress.pct} />
      <Text size={12} mono color={theme.colors.mut}>
        {progress.text}
      </Text>
    </View>
  );
}

function Bar({ pct }: { pct: number }) {
  const theme = useTheme();
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.sf2, overflow: 'hidden' }}>
      <View
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: 6,
          borderRadius: 3,
          backgroundColor: theme.colors.btn,
        }}
      />
    </View>
  );
}
