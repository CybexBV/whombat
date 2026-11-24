/**
 * What Whombat watches on the phone (Whombat quiet-notices.md QN-13…QN-15; quiet-notices-mobile.md AP-4865, AP-4866):
 * one row per check in plain words (“Access points and switches going offline”) with its switch, “Off since 20 Oct
 * (John)” under one switched off, and under it what is excepted — “Not for:”, then a 44dp line per item (“Garage AP
 * until it’s back”, who and when under it) with Undo. The shared `thingWatchView`; the switches and Undo run through
 * the thing's `useQuietActions` (the toast says so). Look only and guests read the same rows with “On” or “Off” instead
 * of a switch and no Undo. Only the rows: the caller puts them in its card (a connection's settings, a server's Summary).
 * A server's check with a limit says when it warns (“Warns above 90 %”, and each item
 * with its own) with Change, which opens Change the limit.
 */
import {
  type LimitView,
  limitLine,
  limitView,
  thingWatchView,
  type WatchCheckView,
  type WatchExceptionView,
} from '@whombat/client';
import type { QuietActions } from '@whombat/client/react';
import type { ThingWatch } from '@whombat/core';
import { useMemo, useState } from 'react';
import { Switch, View } from 'react-native';
import { MONITORING_COPY } from '../../data/monitoring';
import { checkToastName, exceptionText, foldWatchRows, QUIET_COPY, watchRowSpoken } from '../../data/quiet';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ErrorState, SkeletonRows } from '../../ui/primitives';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';

/** Where the rows' hairlines go: on top (a OneCard's rows) or under them (a settings section's). */
type Divider = 'top' | 'bottom';

export function WhatWhombatWatches({
  watch,
  pending,
  failed,
  onRetry,
  actions,
  timeZone,
  now,
  first = null,
  divider,
  inset,
  onLimit = null,
}: {
  watch: ThingWatch | undefined;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
  actions: QuietActions;
  timeZone: string;
  now: number;
  /** Fold after this many checks (a server's Summary); null: all of them. */
  first?: number | null;
  divider: Divider;
  /** The rows' side padding: the card's. */
  inset: number;
  /** Opens Change the limit for a check's limit, or one item's (a server's); none: limits aren't shown. */
  onLimit?: ((view: LimitView) => void) | null;
}) {
  const theme = useTheme();
  const view = useMemo(() => (watch ? thingWatchView(watch, timeZone, now) : null), [watch, timeZone, now]);
  const checks = useMemo(() => new Map((watch?.checks ?? []).map((c) => [c.check as string, c])), [watch]);
  const [open, setOpen] = useState(false);
  if (!view)
    return failed ? (
      <ErrorState text={QUIET_COPY.failed} onRetry={onRetry} />
    ) : pending ? (
      <SkeletonRows count={2} lines={1} label={QUIET_COPY.loading} />
    ) : null;
  const border =
    divider === 'top'
      ? { borderTopWidth: 1, borderTopColor: theme.colors.line }
      : { borderBottomWidth: 1, borderBottomColor: theme.colors.line };
  if (view.empty)
    return (
      <View style={{ paddingVertical: 12, paddingHorizontal: inset, ...border }}>
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {view.empty}
        </Text>
      </View>
    );
  const { shown, more } = foldWatchRows(view, first, open);
  return (
    <>
      {shown.map((row) => (
        <CheckRow
          key={row.check}
          row={row}
          mayChange={view.mayChange}
          actions={actions}
          border={border}
          inset={inset}
          limit={(() => {
            const c = onLimit && view.mayChange ? checks.get(row.check) : undefined;
            return c && onLimit ? { check: c, open: onLimit } : null;
          })()}
        />
      ))}
      {more || open ? (
        <Touchable
          onPress={() => setOpen(!open)}
          feedback="wash"
          accessibilityLabel={open ? QUIET_COPY.showFewer : QUIET_COPY.showMore(more)}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: inset, ...border }}
        >
          <Text size={13.5} weight={600} color={theme.colors.brand}>
            {open ? QUIET_COPY.showFewer : QUIET_COPY.showMore(more)}
          </Text>
        </Touchable>
      ) : null}
      {view.mayChange ? null : (
        <View style={{ paddingVertical: 12, paddingHorizontal: inset, ...border }}>
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {QUIET_COPY.readOnly}
          </Text>
        </View>
      )}
    </>
  );
}

/** One check: its words, its switch (or On/Off), “Off since …” and its exceptions with Undo. */
function CheckRow({
  row,
  mayChange,
  actions,
  border,
  inset,
  limit,
}: {
  row: WatchCheckView;
  mayChange: boolean;
  actions: QuietActions;
  border: object;
  inset: number;
  /** Its limit and what opens Change the limit, for who may change it. */
  limit: { check: ThingWatch['checks'][number]; open: (view: LimitView) => void } | null;
}) {
  const theme = useTheme();
  const busy = actions.busy({ check: row.check });
  return (
    <View style={{ paddingVertical: 6, paddingHorizontal: inset, ...border }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 }}
        accessible={!mayChange}
        {...(mayChange ? {} : { accessibilityLabel: watchRowSpoken(row, false) })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2, paddingVertical: 4 }}>
          <Text size={15} lh={1.35} color={row.on ? theme.colors.ink : theme.colors.mut}>
            {row.name}
          </Text>
          {row.offLine ? (
            <Text size={12} mono color={theme.colors.mut}>
              {row.offLine}
            </Text>
          ) : null}
        </View>
        {mayChange ? (
          <Switch
            value={row.on}
            disabled={busy}
            onValueChange={(on) => actions.watch(row.check, undefined, on, checkToastName(row.name))}
            accessibilityLabel={row.switchLabel}
            accessibilityHint={row.offLine ?? undefined}
            accessibilityRole="switch"
            {...switchColors(theme, row.on)}
            style={{ minHeight: 44 }}
          />
        ) : (
          <Text size={12} weight={500} mono color={theme.colors.mut}>
            {row.on ? QUIET_COPY.on : QUIET_COPY.off}
          </Text>
        )}
      </View>
      {limit && row.on ? <LimitLines check={limit.check} open={limit.open} /> : null}
      {row.exceptions.length ? (
        <View style={{ paddingBottom: 4 }}>
          <Text size={12} mono color={theme.colors.mut} style={{ paddingTop: 2 }}>
            {QUIET_COPY.watchNot}
          </Text>
          {row.exceptions.map((e) => (
            <ExceptionLine key={e.key} exception={e} mayChange={mayChange} actions={actions} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** “Garage AP until it’s back” with who and when under it, and Undo (watch it again, or take back the ignore). */
function ExceptionLine({
  exception: e,
  mayChange,
  actions,
}: {
  exception: WatchExceptionView;
  mayChange: boolean;
  actions: QuietActions;
}) {
  const theme = useTheme();
  const text = exceptionText(e);
  const undo = () => {
    if (e.undo.kind === 'watch')
      actions.watch(e.undo.check, e.undo.subject, true, e.undo.subject?.name ?? e.name);
    else actions.undo(e.undo.ref);
  };
  const busy =
    e.undo.kind === 'watch'
      ? actions.busy(
          e.undo.subject ? { check: e.undo.check, subject: e.undo.subject.id } : { check: e.undo.check },
        )
      : actions.busy(e.undo.ref);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
      <View
        style={{ flex: 1, minWidth: 0, gap: 1 }}
        accessible
        accessibilityLabel={[text, e.who].filter(Boolean).join(', ')}
      >
        <Text size={13.5} lh={1.4} color={theme.colors.ink2}>
          {text}
        </Text>
        {e.who ? (
          <Text size={11.5} mono color={theme.colors.mut}>
            {e.who}
          </Text>
        ) : null}
      </View>
      {mayChange ? (
        <Touchable
          onPress={undo}
          disabled={busy}
          feedback="fade"
          ringRadius={10}
          accessibilityLabel={e.undoLabel}
          style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
        >
          <Text size={13} weight={600} color={theme.colors.brand}>
            {QUIET_COPY.undo}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** A check's limit: “Warns above 90 %” (or what applies without one) and each item with its own, each with Change. */
function LimitLines({
  check,
  open,
}: {
  check: ThingWatch['checks'][number];
  open: (view: LimitView) => void;
}) {
  const whole = limitView(check);
  const line = limitLine(check);
  if (!whole || !line) return null;
  return (
    <View style={{ paddingBottom: 4 }}>
      <LimitLine
        text={line.words}
        spoken={MONITORING_COPY.changeLimitHint(check.name)}
        onPress={() => open(whole)}
      />
      {line.items.map((item) => {
        const own = limitView(check, item.subject);
        return own ? (
          <LimitLine
            key={item.subject.id}
            text={`${item.subject.name} ${item.words}`}
            spoken={MONITORING_COPY.changeLimitHint(`${check.name} · ${item.subject.name}`)}
            onPress={() => open(own)}
          />
        ) : null;
      })}
    </View>
  );
}

/**
 * One limit's words in mono under the check's name, as “Off since …” is, and Change at the switch's edge: 32 tall with
 * slop to 44, so the lines sit close to the check they belong to.
 */
function LimitLine({ text, spoken, onPress }: { text: string; spoken: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, marginTop: -6 }}>
      <Text size={12} mono color={theme.colors.mut} style={{ flex: 1, minWidth: 0 }}>
        {text}
      </Text>
      <Touchable
        onPress={onPress}
        feedback="fade"
        ringRadius={10}
        accessibilityRole="button"
        accessibilityLabel={MONITORING_COPY.changeLimit}
        accessibilityHint={spoken}
        hitSlop={hitSlopFor(32)}
        style={{
          minHeight: 32,
          minWidth: 44,
          paddingLeft: 10,
          justifyContent: 'center',
          alignItems: 'flex-end',
        }}
      >
        <Text size={13} weight={600} color={theme.colors.brand}>
          {QUIET_COPY.change}
        </Text>
      </Touchable>
    </View>
  );
}
