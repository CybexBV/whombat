/**
 * Monitoring's parts on a thing's and a server's screen (Whombat monitoring.md MON-04, MON-07, MON-09, MON-15), in the
 * phone's own patterns:
 * - **Keep quiet…** (`KeepQuietSheet`): the one-Whombat sheet with “Keep pve-02 quiet”, what it means, the choices as
 *   radio cards (For an hour, Until tonight, Until tomorrow morning, each saying until when, and Pick a time: a row of
 *   days and the clock), an optional note, Keep quiet and Cancel. The toast says until when, with Undo.
 * - **The hold under the head** (`KeptQuietLine`): “Quiet until 23:00 · Moving the NAS”, who kept it quiet, and End now
 *   for who may end it; and a cause's way to what it depends on (`CauseLink`: “Open pve-02 ›”).
 * - **What happened** (`WhatHappenedCard`): the last 30 days' outages and problems, newest first, each with when, how
 *   long and its cause; a server's own alerts folded under them; “Nothing went wrong in the last 30 days.” Asked only of
 *   a Whombat that has it.
 * - **Change the limit** (`LimitSheet`): the value with its unit, the range, the default and Use the default; Save
 *   says so in a toast with Undo.
 * The words, times and rules are the shared ones (`@whombat/client`'s monitoring parts); this only draws them.
 */
import {
  HISTORY_WORDS,
  type HistoryRow,
  historyView,
  KEEP_QUIET_WORDS,
  type KeepQuietChoice,
  keepQuietBody,
  keepQuietOptions,
  keepQuietTitle,
  LIMIT_WORDS,
  type LimitView,
  parseLimit,
} from '@whombat/client';
import { type KeepQuietActions, useThingHistory, type WatchLimitActions } from '@whombat/client/react';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { firstPick, MONITORING_COPY, pickDays, pickedValue } from '../../data/monitoring';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard } from '../../ui/assistant';
import { ClockField } from '../../ui/ClockField';
import { FormField } from '../../ui/formField';
import { BellOff, ChevronRight } from '../../ui/icons';
import { OneSheet } from '../../ui/oneSheet';
import { Chip, SkeletonRows } from '../../ui/primitives';
import { RadioCards } from '../../ui/radioCards';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { FoldRow } from './Panels';
import { CardQuiet } from './parts';

/* Keep quiet… ----------------------------------------------------------------------------------------------------- */

/** The sheet behind ⋯ → Keep quiet…; its choices are read when it opens, so “Until tonight” is offered only while ahead. */
export function KeepQuietSheet({
  visible,
  name,
  actions,
  onClose,
}: {
  visible: boolean;
  name: string;
  actions: KeepQuietActions;
  onClose: () => void;
}) {
  return visible ? <KeepQuietBody name={name} actions={actions} onClose={onClose} /> : null;
}

function KeepQuietBody({
  name,
  actions,
  onClose,
}: {
  name: string;
  actions: KeepQuietActions;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  // The choices as they were when the sheet opened: the minute ticking doesn't move a choice under the finger.
  const [opened] = useState(() => now.getTime());
  const options = useMemo(() => keepQuietOptions(opened, timeZone), [opened, timeZone]);
  const days = useMemo(() => pickDays(opened, timeZone), [opened, timeZone]);
  const [choice, setChoice] = useState<KeepQuietChoice>('hour');
  const [pick, setPick] = useState(() => firstPick(opened, timeZone));
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const keep = () => {
    const asked = keepQuietBody(choice, {
      now: Date.now(),
      timeZone,
      picked: pickedValue(pick.day, pick.clock),
      note,
    });
    if ('problem' in asked) return setProblem(asked.problem);
    setProblem(null);
    void actions.keep(asked.body).then((ok) => {
      if (ok) onClose();
    });
  };
  return (
    <OneSheet
      visible
      onClose={() => !actions.busy && onClose()}
      badge={name}
      tone="mut"
      title={keepQuietTitle(name)}
      body={KEEP_QUIET_WORDS.body}
      busy={actions.busy ? 'keep' : null}
      buttons={[
        { id: 'keep', label: KEEP_QUIET_WORDS.button, variant: 'primary', onPress: keep },
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
      note={problem}
    >
      <View style={{ gap: 14, marginTop: 16 }}>
        <RadioCards<KeepQuietChoice>
          label={keepQuietTitle(name)}
          value={choice}
          onChange={(c) => {
            setChoice(c);
            setProblem(null);
          }}
          options={options.map((o) => ({
            value: o.choice,
            title: o.label,
            line: o.ends ? `Until ${o.ends}` : null,
          }))}
        />
        {choice === 'pick' ? (
          <View style={{ gap: 10 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {MONITORING_COPY.day.toUpperCase()}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
            >
              {days.map((d) => (
                <Chip
                  key={d.value}
                  label={d.label}
                  active={pick.day === d.value}
                  onPress={() => {
                    setPick((p) => ({ ...p, day: d.value }));
                    setProblem(null);
                  }}
                />
              ))}
            </ScrollView>
            <ClockField
              label={MONITORING_COPY.time}
              spoken={`${KEEP_QUIET_WORDS.pickLabel} ${MONITORING_COPY.time.toLowerCase()}`}
              value={pick.clock}
              onChange={(clock) => {
                setPick((p) => ({ ...p, clock }));
                setProblem(null);
              }}
            />
          </View>
        ) : null}
        <FormField
          label={KEEP_QUIET_WORDS.note}
          value={note}
          onChangeText={setNote}
          placeholder={KEEP_QUIET_WORDS.notePlaceholder}
          maxLength={120}
          returnKeyType="done"
        />
      </View>
    </OneSheet>
  );
}

/* The hold under the head ------------------------------------------------------------------------------------------ */

/**
 * “Quiet until 23:00 · Moving the NAS” under the head while the thing is kept quiet: the quiet bell, the words, who kept
 * it quiet under them, and End now on the right for who may end it (44pt).
 */
export function KeptQuietLine({
  words,
  who,
  endNow,
  busy,
  onEnd,
}: {
  words: string;
  who: string | null;
  endNow: boolean;
  busy: boolean;
  onEnd: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 14,
        paddingRight: endNow ? 6 : 14,
        paddingVertical: 8,
        minHeight: 56,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View accessible accessibilityLabel={[words, who].filter(Boolean).join('. ')} style={ROW}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <BellOff size={18} color={theme.colors.ink2} strokeWidth={1.8} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text size={15} weight={600} lh={1.35}>
            {words}
          </Text>
          {who ? (
            <Text size={13} color={theme.colors.mut} numberOfLines={1}>
              {who}
            </Text>
          ) : null}
        </View>
      </View>
      {endNow ? (
        <Touchable
          onPress={onEnd}
          disabled={busy}
          feedback="fade"
          ringRadius={10}
          accessibilityRole="button"
          accessibilityLabel={MONITORING_COPY.endNow}
          accessibilityHint={MONITORING_COPY.endNowHint}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
        >
          <Text size={14} weight={600} color={theme.colors.brand} style={{ opacity: busy ? 0.5 : 1 }}>
            {MONITORING_COPY.endNow}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

const ROW = { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 } as const;

/** The way to what a thing is down because of: “Open pve-02 ›” in `brand`, as “Runs on” is drawn. */
export function CauseLink({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={MONITORING_COPY.openCauseHint}
      hitSlop={hitSlopFor(36)}
      style={{ alignSelf: 'flex-start', minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Text size={13.5} weight={600} color={theme.colors.brand}>
        {label}
      </Text>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ChevronRight size={15} color={theme.colors.brand} strokeWidth={2} />
      </View>
    </Touchable>
  );
}

/* What happened ---------------------------------------------------------------------------------------------------- */

/** How many outages show before “Show N more”. */
const HISTORY_FIRST = 5;

/** The last 30 days of a thing or server (`things.history`); nothing on a Whombat that doesn't keep it. */
export function WhatHappenedCard({ thing }: { thing: string }) {
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const history = useThingHistory(slug, thing, 30);
  const [open, setOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const view = useMemo(
    () => (history.data ? historyView(history.data, now, timeZone) : null),
    [history.data, now, timeZone],
  );
  if (!history.supported) return null;
  const rows = view ? (open ? view.rows : view.rows.slice(0, HISTORY_FIRST)) : [];
  const more = view ? view.rows.length - rows.length : 0;
  return (
    <OneCard label={HISTORY_WORDS.title} meta={view?.uptime ?? null}>
      {history.isPending ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          <SkeletonRows count={2} lines={2} label={MONITORING_COPY.historyLoading} />
        </View>
      ) : !view ? (
        <>
          <CardQuiet text={HISTORY_WORDS.failed} />
          <FoldRow label="Try again" onPress={() => void history.refetch()} />
        </>
      ) : (
        <>
          {view.empty ? <CardQuiet text={view.empty} /> : null}
          {rows.map((r) => (
            <HistoryLine key={r.id} row={r} />
          ))}
          {more > 0 || (open && view.rows.length > HISTORY_FIRST) ? (
            <FoldRow
              label={open ? HISTORY_WORDS.fewer : `Show ${more} more`}
              onPress={() => setOpen(!open)}
            />
          ) : null}
          {alertsOpen ? view.alerts.map((r) => <HistoryLine key={r.id} row={r} />) : null}
          {view.alerts.length ? (
            <FoldRow
              label={alertsOpen ? HISTORY_WORDS.fewer : HISTORY_WORDS.alerts(view.alerts.length)}
              onPress={() => setAlertsOpen(!alertsOpen)}
            />
          ) : null}
        </>
      )}
    </OneCard>
  );
}

/** One outage or alert: its tone's dot, what it was, then when and how long, and its cause under that. */
function HistoryLine({ row }: { row: HistoryRow }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={[row.words, row.when, row.cause].filter(Boolean).join('. ')}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 11,
        minHeight: 52,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ width: 20, alignItems: 'center', paddingTop: 7 }}>
        <Dot tone={row.open ? row.tone : null} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600} numberOfLines={2}>
          {row.words}
        </Text>
        <Text size={13} color={theme.colors.mut} numberOfLines={1}>
          {row.when}
        </Text>
        {row.cause ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {row.cause}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/* Change the limit ------------------------------------------------------------------------------------------------- */

/** The sheet for a check's limit, for the whole server or one item; null closes it. */
export function LimitSheet({
  view,
  actions,
  onClose,
}: {
  view: LimitView | null;
  actions: WatchLimitActions;
  onClose: () => void;
}) {
  return view ? (
    <LimitBody
      key={`${view.check}|${view.subject?.id ?? ''}`}
      view={view}
      actions={actions}
      onClose={onClose}
    />
  ) : null;
}

function LimitBody({
  view,
  actions,
  onClose,
}: {
  view: LimitView;
  actions: WatchLimitActions;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState(view.value === null ? '' : String(view.value));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'default' | null>(null);
  const run = (which: 'save' | 'default', limit: number | null) => {
    setBusy(which);
    void actions
      .set({ check: view.check, subject: view.subject, name: view.name, unit: view.unit, limit })
      .then((ok) => {
        setBusy(null);
        if (ok) onClose();
      });
  };
  const save = () => {
    const value = parseLimit(typed, view);
    if (typeof value !== 'number') return setProblem(value.problem);
    setProblem(null);
    run('save', value);
  };
  return (
    <OneSheet
      visible
      onClose={() => !busy && onClose()}
      badge={view.about}
      tone="mut"
      title={LIMIT_WORDS.title}
      body={`${view.defaultWords} ${view.rangeWords}`}
      busy={busy}
      buttons={[
        { id: 'save', label: LIMIT_WORDS.save, variant: 'primary', onPress: save },
        ...(view.own
          ? [
              {
                id: 'default',
                label: LIMIT_WORDS.useDefault,
                variant: 'secondary' as const,
                onPress: () => run('default', null),
              },
            ]
          : []),
        { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: onClose },
      ]}
    >
      <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <FormField
            label={LIMIT_WORDS.label}
            value={typed}
            onChangeText={(v) => {
              setTyped(v);
              setProblem(null);
            }}
            error={problem}
            keyboardType="decimal-pad"
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel={`${LIMIT_WORDS.label}, ${view.unit}`}
            maxLength={5}
            mono
          />
        </View>
        <UnitWord unit={view.unit} raised={!!problem} />
      </View>
    </OneSheet>
  );
}

/** The unit beside the field (“%”, “°C”), level with the box. */
function UnitWord({ unit, raised }: { unit: string; raised: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ minHeight: 44, justifyContent: 'center', marginBottom: raised ? 24 : 0 }}>
      <Text size={16} weight={500} color={theme.colors.ink2}>
        {unit}
      </Text>
    </View>
  );
}
