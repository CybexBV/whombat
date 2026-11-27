/**
 * Backup places on the phone's Backups screen (Whombat backup-places.md BPL-04…BPL-10; app backup-places.md
 * AP-6717…AP-6722), the web's ON YOUR NETWORK in a settings card: each place's logo tile, name, one line and its one
 * action — Back up here (asked first in a sheet when another place keeps the backups, then the minute or two it takes
 * said in its row), Connect it first (the entry's connect screen, or Add a server for an Unraid or Linux computer),
 * Turn on Manage first (the server's page or the connection's), Set it up by hand (a sheet with the steps, the app to
 * paste with Copy, and Check it). A place with more than one location asks “Where on BlackBox?” in a sheet first
 * (backup-places.md BPL-13); the place in use names its location and offers Change, which moves the backups after a
 * confirm in the place's own terms, said plainly while it runs and followed past the session's wait (BPL-14, BPL-S20).
 * `CurrentPlaceRow` is BACKUPS' line naming the place in use. A box from before (`unknown_op`) shows nothing new. Rows,
 * words and actions are `@whombat/client`'s, so the web says the same.
 */
import {
  accountsText,
  BACKUP_PLACE_DEADLINE_MS,
  type BackupPlaceAction,
  type BackupPlaceRow,
  backupPlaceRows,
  backupPlacesText,
  currentPlaceLine,
  moveFromPlace,
  moveNeeded,
  placeErrorText,
  placeLocationChange,
  placeLocations,
  placeMoveMayRun,
  placeSetNotes,
  waitForPlaceLocation,
} from '@whombat/client/managed';
import { useBackupPlaces, useReloadBackupPlaces } from '@whombat/client/react';
import { type BackupPlaceByHand, sessionOps } from '@whombat/client/session';
import { type BackupPlace, backupPlaceText } from '@whombat/core/domain';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { connectionLogo } from '../data/connections';
import { useI18n } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import { copyToClipboard } from '../ui/clipboard';
import { tint } from '../ui/glanceColors';
import { Check } from '../ui/icons';
import { OneSheet } from '../ui/oneSheet';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { useManagedOrThrow } from './context';
import { Card, Note } from './ui';

/** A row with the place's logo tile: the settings card's row (`Row`) with the tile where its dot goes. */
function PlaceLine({
  mark,
  title,
  line,
  note,
  first,
  action,
}: {
  mark: string;
  title: string;
  line: string;
  note?: { text: string; error: boolean } | null;
  first?: boolean;
  action?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <ConnectionLogo logo={connectionLogo(mark)} size={32} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut} accessibilityLiveRegion="polite">
          {line}
        </Text>
        {note ? (
          <Text
            size={13}
            lh={1.4}
            color={note.error ? theme.colors.bad : theme.colors.ink2}
            accessibilityLiveRegion={note.error ? 'assertive' : 'polite'}
            {...(note.error ? { accessibilityRole: 'alert' as const } : {})}
          >
            {note.text}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

/** BACKUPS' line for the place that keeps the backups now (BPL-10); nothing while none does. */
export function CurrentPlaceRow() {
  const { rawLocale } = useI18n();
  const { session } = useManagedOrThrow();
  const places = useBackupPlaces(session);
  const line = currentPlaceLine(places.data, rawLocale);
  if (!line) return null;
  return <PlaceLine mark={line.mark} title={line.title} line={line.meta} />;
}

type Asking = { row: BackupPlaceRow; from: string; byHand: boolean; location?: string };
type Choosing = { row: BackupPlaceRow; mode: 'use' | 'change' };
type Changing = {
  row: BackupPlaceRow;
  location: string;
  change: NonNullable<ReturnType<typeof placeLocationChange>>;
};

/** ON YOUR NETWORK. `onChanged` follows a place that was set (BACKUPS reads its state again). */
export function BackupPlacesCard({
  onChanged,
  onKit,
}: {
  onChanged: () => void;
  /** A Whombat from before the passkey: a new place needs a new recovery kit. Absent: the passkey locks it again. */
  onKit?: (() => void) | undefined;
}) {
  const { rawLocale } = useI18n();
  const W = backupPlacesText(rawLocale);
  const placeText = backupPlaceText(rawLocale);
  const managed = useManagedOrThrow();
  const { session } = managed;
  const navigation = useAppNavigation();
  const places = useBackupPlaces(session);
  const reload = useReloadBackupPlaces();
  const [working, setWorking] = useState<{ id: string; moving: string | null } | null>(null);
  const busy = working?.id ?? null;
  const [notes, setNotes] = useState<Record<string, { text: string; error: boolean }>>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [changing, setChanging] = useState<Changing | null>(null);
  const [byHand, setByHand] = useState<BackupPlaceRow | null>(null);
  const [kitNeeded, setKitNeeded] = useState(false);
  // A move read after its call stops when the screen goes.
  const alive = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const rows = backupPlaceRows(places.data, rawLocale);
  if (rows.length === 0) return null;
  const placeOf = (id: string): BackupPlace | null => places.data?.places.find((p) => p.id === id) ?? null;

  const note = (id: string, text: string | null, error = false) =>
    setNotes((n) => {
      const next = { ...n };
      if (text) next[id] = { text, error };
      else delete next[id];
      return next;
    });

  /** Sets the place up (or, made by hand, checks it); a refusal to move without the person's word asks first. */
  const use = async (
    row: BackupPlaceRow,
    move: boolean,
    check = false,
    location?: string,
  ): Promise<boolean> => {
    setWorking({ id: row.id, moving: null });
    note(row.id, null);
    try {
      const input = { placeId: row.id, ...(move ? { move: true } : {}), ...(location ? { location } : {}) };
      const options = { deadlineMs: BACKUP_PLACE_DEADLINE_MS };
      const result = check
        ? await sessionOps.backupPlaceCheck(session, input, options)
        : await sessionOps.backupUsePlace(session, input, options);
      note(row.id, placeSetNotes({ ...result, locale: rawLocale }));
      setKitNeeded(true);
      await reload();
      onChanged();
      return true;
    } catch (error) {
      const needed = move ? null : moveNeeded(error, rawLocale);
      if (needed) setAsking({ row, from: needed.from, byHand: check, ...(location ? { location } : {}) });
      else note(row.id, placeErrorText(error, rawLocale), true);
      return false;
    } finally {
      setWorking(null);
    }
  };

  /**
   * Where on the place in use, chosen again (BPL-14): on Unraid or Linux the backups move there, up to an hour; the box
   * carries on whatever the app does, so a call that ends without an answer reads the places until they are there. A
   * NAS sets up a new repository there, as setting a place up does.
   */
  const moveTo = async ({ row, location, change }: Changing) => {
    setWorking({ id: row.id, moving: change.move ? null : change.name });
    note(row.id, null);
    try {
      const result = await sessionOps.backupUsePlace(
        session,
        { placeId: row.id, location, ...(change.move ? { move: true } : {}) },
        { deadlineMs: BACKUP_PLACE_DEADLINE_MS },
      );
      note(
        row.id,
        change.move
          ? placeSetNotes({ ...result, locale: rawLocale })
          : W.moved(result.locationName ?? change.where),
      );
      // A NAS starts a new repository there, which a new recovery kit needs.
      if (change.move) setKitNeeded(true);
    } catch (error) {
      if (change.move || !placeMoveMayRun(error)) note(row.id, placeErrorText(error, rawLocale), true);
      else {
        const signal = alive.current.signal;
        const there = await waitForPlaceLocation(() => sessionOps.backupPlaces(session), row.id, location, {
          signal,
        });
        if (signal.aborted) return;
        note(row.id, there ? W.moved(change.where) : W.slow);
      }
    } finally {
      setWorking(null);
    }
    await reload();
    onChanged();
  };

  /** Asked first when another place keeps the backups (BPL-06). */
  const backUpAt = (row: BackupPlaceRow, location?: string) => {
    const from = moveFromPlace(places.data, row.id, rawLocale);
    if (from) setAsking({ row, from, byHand: false, ...(location ? { location } : {}) });
    else void use(row, false, false, location);
  };

  /** Where on it first, when it has more than one location (BPL-13). */
  const backUpHere = (row: BackupPlaceRow) => {
    if (placeLocations(placeOf(row.id), rawLocale)) setChoosing({ row, mode: 'use' });
    else backUpAt(row);
  };

  const chosen = (location: string) => {
    if (!choosing) return;
    const { row, mode } = choosing;
    setChoosing(null);
    if (mode === 'use') return backUpAt(row, location);
    const place = placeOf(row.id);
    const change = place ? placeLocationChange(place, location, rawLocale) : null;
    if (change) setChanging({ row, location, change });
  };

  const follow = (row: BackupPlaceRow, action: BackupPlaceAction) => {
    if (action.kind === 'connect') {
      if (action.asServer) navigation.navigate('AddServer', { address: action.address ?? undefined });
      else
        navigation.navigate('Connect', {
          catalogId: action.catalogId,
          ...(action.address ? { url: action.address } : {}),
        });
    } else if (action.kind === 'manage') {
      const connectionId = action.thing.startsWith('connection:') ? action.thing.slice(11) : null;
      if (connectionId) navigation.navigate('Connection', { connectionId, title: row.name });
      else navigation.navigate('Thing', { thingId: action.thing, title: row.name });
    }
  };

  return (
    <>
      <Card label={W.heading}>
        {rows.map((row, i) => {
          const a = row.action;
          const running = busy === row.id;
          const moving = running ? (working?.moving ?? null) : null;
          return (
            <PlaceLine
              key={row.id}
              first={i === 0}
              mark={row.mark}
              title={row.name}
              line={moving ? W.moving(moving) : running ? W.settingUp(row.name) : row.line}
              note={running ? null : (notes[row.id] ?? null)}
              action={
                a ? (
                  <Button
                    label={moving ? W.movingButton : running ? W.settingUpButton : a.label}
                    variant="secondary"
                    disabled={busy !== null}
                    accessibilityLabel={
                      a.kind === 'change'
                        ? `${a.label}: ${W.whereTitle(row.name)}`
                        : `${a.label}: ${row.name}`
                    }
                    onPress={() =>
                      a.kind === 'use'
                        ? backUpHere(row)
                        : a.kind === 'change'
                          ? setChoosing({ row, mode: 'change' })
                          : a.kind === 'byHand'
                            ? setByHand(row)
                            : follow(row, a)
                    }
                  />
                ) : null
              }
            />
          );
        })}
        {kitNeeded && onKit ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Note text={accountsText(rawLocale).newKit} />
            <Button label={accountsText(rawLocale).saveKit} variant="secondary" onPress={onKit} />
          </View>
        ) : null}
      </Card>

      <OneSheet
        visible={asking !== null}
        onClose={() => setAsking(null)}
        title={asking ? placeText.moveTitle(asking.row.name) : ''}
        body={asking ? placeText.moveBody(asking.from) : null}
        buttons={
          asking
            ? [
                {
                  id: 'move',
                  label: asking.byHand ? placeText.check : placeText.use,
                  variant: 'primary',
                  onPress: () => {
                    setAsking(null);
                    void use(asking.row, true, asking.byHand, asking.location);
                  },
                },
                { id: 'cancel', label: W.cancel, variant: 'secondary', onPress: () => setAsking(null) },
              ]
            : []
        }
      />

      {choosing ? (
        <WhereSheet
          name={choosing.row.name}
          place={placeOf(choosing.row.id)}
          mode={choosing.mode}
          onClose={() => setChoosing(null)}
          onChoose={chosen}
        />
      ) : null}

      <OneSheet
        visible={changing !== null}
        onClose={() => setChanging(null)}
        title={changing?.change.title ?? ''}
        body={changing?.change.body ?? null}
        buttons={
          changing
            ? [
                {
                  id: 'change',
                  label: changing.change.button,
                  variant: 'primary',
                  onPress: () => {
                    setChanging(null);
                    void moveTo(changing);
                  },
                },
                { id: 'cancel', label: W.cancel, variant: 'secondary', onPress: () => setChanging(null) },
              ]
            : []
        }
      />

      {byHand ? (
        <ByHandSheet
          row={byHand}
          busy={busy === byHand.id}
          error={notes[byHand.id]?.error ? notes[byHand.id]?.text : null}
          onClose={() => setByHand(null)}
          onCheck={async () => {
            const from = moveFromPlace(places.data, byHand.id, rawLocale);
            if (from) {
              setByHand(null);
              setAsking({ row: byHand, from, byHand: true });
              return;
            }
            if (await use(byHand, false, true)) setByHand(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * “Where on BlackBox?” (BPL-13) as a sheet: the place's locations as rows to pick one from, the recommended one first and
 * marked, the one in use marked; preselected is the one in use, else the recommended one. Back up here (or, on the place
 * in use, Change: only to another one) sends the choice.
 */
function WhereSheet({
  name,
  place,
  mode,
  onClose,
  onChoose,
}: {
  name: string;
  place: BackupPlace | null;
  mode: 'use' | 'change';
  onClose: () => void;
  onChoose: (location: string) => void;
}) {
  const { rawLocale } = useI18n();
  const W = backupPlacesText(rawLocale);
  const theme = useTheme();
  const asked = placeLocations(place, rawLocale);
  const [picked, setPicked] = useState(asked?.selected ?? '');
  if (!asked) return null;
  const current = asked.rows.find((r) => r.current)?.id ?? null;
  const tag = (text: string, ok: boolean) => (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: ok ? tint(theme.colors.ok, 0.45) : theme.colors.line,
        backgroundColor: ok ? tint(theme.colors.ok, 0.14) : theme.colors.sf2,
      }}
    >
      <Text size={11.5} weight={600} lh={1.45} color={ok ? theme.colors.ink : theme.colors.ink2}>
        {text}
      </Text>
    </View>
  );
  return (
    <OneSheet
      visible
      onClose={onClose}
      title={W.whereTitle(name)}
      body={W.whereLead}
      buttons={[
        {
          id: 'choose',
          label: mode === 'change' ? W.change : backupPlaceText(rawLocale).use,
          variant: 'primary',
          disabled: !picked || (mode === 'change' && picked === current),
          onPress: () => onChoose(picked),
        },
        { id: 'cancel', label: W.cancel, variant: 'secondary', onPress: onClose },
      ]}
    >
      <View accessibilityRole="radiogroup" style={{ marginTop: 14, gap: 10 }}>
        {asked.rows.map((r) => {
          const checked = r.id === picked;
          const said = [r.name, r.recommended ? W.recommended : null, r.current ? W.inUse : null, r.line]
            .filter(Boolean)
            .join('. ');
          return (
            <Touchable
              key={r.id}
              onPress={() => setPicked(r.id)}
              feedback="wash"
              accessibilityRole="radio"
              accessibilityState={{ checked }}
              accessibilityLabel={said}
              style={{
                minHeight: 56,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 14,
                borderWidth: 1.5,
                borderColor: checked ? theme.colors.ink : theme.colors.line,
                backgroundColor: theme.colors.sf,
              }}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <Text size={15} weight={600}>
                    {r.name}
                  </Text>
                  {r.recommended ? tag(W.recommended, true) : null}
                  {r.current ? tag(W.inUse, false) : null}
                </View>
                {r.line ? (
                  <Text size={13} lh={1.4} color={theme.colors.ink2}>
                    {r.line}
                  </Text>
                ) : null}
              </View>
              {checked ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
            </Touchable>
          );
        })}
      </View>
    </OneSheet>
  );
}

/**
 * Set it up by hand (BPL-09): the steps, the app to paste with Copy, and Check it, which sets the destination once the
 * app answers. The app is asked for when the sheet opens (it holds the user's bcrypt line, never the password).
 */
function ByHandSheet({
  row,
  busy,
  error,
  onClose,
  onCheck,
}: {
  row: BackupPlaceRow;
  busy: boolean;
  error: string | null | undefined;
  onClose: () => void;
  onCheck: () => Promise<void>;
}) {
  const { rawLocale } = useI18n();
  const W = backupPlacesText(rawLocale);
  const { session } = useManagedOrThrow();
  const theme = useTheme();
  const [sheet, setSheet] = useState<BackupPlaceByHand | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    sessionOps.backupPlaceByHand(session, row.id).then(
      (s) => live && setSheet(s),
      () => live && setSheet('failed'),
    );
    return () => {
      live = false;
    };
  }, [session, row.id]);
  const ready = sheet !== null && sheet !== 'failed';
  return (
    <OneSheet
      visible
      onClose={onClose}
      title={W.byHandTitle(row.name)}
      body={W.byHandLead}
      busy={busy ? 'check' : null}
      note={busy ? W.settingUp(row.name) : (error ?? (sheet === 'failed' ? W.byHandFailed : null))}
      buttons={[
        {
          id: 'check',
          label: backupPlaceText(rawLocale).check,
          variant: 'primary',
          disabled: !ready,
          onPress: () => void onCheck(),
        },
        { id: 'close', label: W.close, variant: 'secondary', onPress: onClose },
      ]}
    >
      {sheet === null ? (
        <View style={{ marginTop: 14 }}>
          <Note text={W.byHandLoading} />
        </View>
      ) : ready ? (
        <View style={{ marginTop: 14, gap: 12 }}>
          {sheet.steps.map((step, i) => (
            <View key={step} style={{ flexDirection: 'row', gap: 8 }}>
              <Text size={15} lh={1.45} color={theme.colors.mut} style={{ minWidth: 18 }}>
                {`${i + 1}.`}
              </Text>
              <Text size={15} lh={1.45} style={{ flex: 1 }}>
                {step}
              </Text>
            </View>
          ))}
          <View
            style={{
              borderRadius: 14,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.sf2,
              padding: 12,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text size={12} mono color={theme.colors.mut}>
                {W.compose}
              </Text>
              <Button
                label={W.copy}
                variant="quiet"
                accessibilityLabel={`${W.copy}: ${W.compose}`}
                onPress={() => void copyToClipboard(sheet.compose, W.copied, rawLocale)}
              />
            </View>
            <Text size={11.5} mono lh={1.45} selectable>
              {sheet.compose}
            </Text>
          </View>
        </View>
      ) : null}
    </OneSheet>
  );
}
