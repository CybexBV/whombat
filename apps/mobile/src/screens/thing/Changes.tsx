/**
 * What Whombat changed on a thing (Whombat connection-pages.md CP-05, CP-06, CP-12; connection-pages-mobile.md
 * AP-1958, AP-1959): the Overview's “Whombat did here” (the newest few; left out while there are none) and the
 * Activity tab (everything, newest first, “Show older” for more), read from `changes.list?thing=`. Each row says what
 * changed and when; Undo while it can be undone (its inverse runs through the pipeline, so it may ask a person first),
 * “Undone” once it was, Review where there is something to look at. A person's own change (Restart) has no Undo.
 */

import { type DoneRow, doneRows, undoOutcome } from '@whombat/client';
import { useChanges, useUndoChange } from '@whombat/client/react';
import type { ChangeEntry } from '@whombat/core';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { ACTIVITY_PAGE, thingPageCopy } from '../../data/thingPage';
import { useTheAgentHere } from '../../data/useAgent';
import { useI18n, useMobileT } from '../../i18n';
import { openHref } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { Button, ErrorState, QuietText, SkeletonRows } from '../../ui/primitives';
import { showNotice, useDecisionFeedback } from '../feedback';
import type { PanelContext, PanelThing } from './Panels';
import { HeaderLink } from './parts';

/** Undo with its outcome said: “Undone.”, that it waits for a person, or that the assistant was asked (its chat opens). */
function useUndo() {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const { slug } = useBurrowBase();
  const assistantName = useTheAgentHere()?.name ?? null;
  const undo = useUndoChange(slug);
  const feedback = useDecisionFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = (change: ChangeEntry) => {
    if (busy) return;
    setBusy(change.id);
    undo
      .mutateAsync(change.id)
      .then((result) => {
        if (result.status !== 'ok') return feedback.onResult(result);
        if (result.data.state === 'requested') {
          // The assistant puts it back in its chat: that opens, where it says so (backup-places.md BPL-15).
          const outcome = undoOutcome(result.data, assistantName);
          showNotice(outcome.message);
          if (outcome.kind === 'requested' && outcome.href) openHref(outcome.href);
          return;
        }
        showNotice(result.data.state === 'asked' ? thingPageCopyHere.undoAsked : thingPageCopyHere.undoDone);
      }, feedback.onError)
      .finally(() => setBusy(null));
  };
  return { busy, run };
}

/** One change: what and when (one element for TalkBack), then Undo, Review or “Undone”. */
function ChangeRow({
  row,
  first,
  busy,
  onUndo,
  onReview,
}: {
  row: DoneRow;
  first: boolean;
  busy: boolean;
  onUndo: () => void;
  onReview: (href: string) => void;
}) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const theme = useTheme();
  const who = row.change.actor.kind === 'person' ? row.change.actor.name : null;
  const meta = [row.when, who].filter(Boolean).join(' · ');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        minHeight: 52,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        style={{ flex: 1, minWidth: 0, gap: 2 }}
        accessible
        accessibilityLabel={[row.title, row.detail, meta, row.undone ? thingPageCopyHere.undone : null]
          .filter(Boolean)
          .join('. ')}
      >
        <Text
          size={15}
          weight={600}
          numberOfLines={2}
          color={row.undone ? theme.colors.mut : theme.colors.ink}
        >
          {row.title}
        </Text>
        {row.detail ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {row.detail}
          </Text>
        ) : null}
        <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
          {meta}
        </Text>
      </View>
      {row.action === 'undo' ? (
        <Button
          label={thingPageCopyHere.undo}
          variant="secondary"
          busy={busy}
          onPress={onUndo}
          accessibilityHint={row.title}
        />
      ) : row.action === 'review' && row.href ? (
        <Button
          label={thingPageCopyHere.review}
          variant="quiet"
          onPress={() => onReview(row.href as string)}
          accessibilityHint={row.title}
        />
      ) : row.undone ? (
        <Text size={12} mono color={theme.colors.mut}>
          {thingPageCopyHere.undone}
        </Text>
      ) : null}
    </View>
  );
}

/** The thing page's own address, as a change's `link` names it (`/things/connection%3Acon_ha`). */
const thingPageHref = (thingId: string) => `/things/${encodeURIComponent(thingId)}`;

/** “Whombat did here” on the Overview: the newest `limit`, “Show all” opening Activity; none, no card. */
export function ChangesCard({ title, limit, ctx }: { title: string; limit: number; ctx: PanelContext }) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const list = useChanges(
    { params: { burrow: slug }, query: { thing: ctx.thing.id, limit } },
    { retry: false },
  );
  // A change that links to this page shows no Review here (AP-4573).
  const here = thingPageHref(ctx.thing.id);
  const rows = useMemo(
    () => doneRows(list.data?.changes ?? [], now, timeZone, { here }),
    [list.data, now, timeZone, here],
  );
  const { busy, run } = useUndo();
  if (!rows.length) return null;
  const more = !!list.data?.before;
  return (
    <OneCard
      label={title}
      right={
        more ? (
          <HeaderLink
            label={thingPageCopyHere.showEverything}
            hint={thingPageCopyHere.showEverythingHint}
            onPress={() => ctx.run({ kind: 'tab', tab: 'activity' })}
          />
        ) : undefined
      }
    >
      {rows.map((r) => (
        <ChangeRow
          key={r.id}
          row={r}
          first={false}
          busy={busy === r.id}
          onUndo={() => run(r.change)}
          onReview={(href) => ctx.run({ kind: 'href', href })}
        />
      ))}
    </OneCard>
  );
}

/** The Activity tab: every change on the thing, newest first, a page at a time. */
export function ThingActivity({ page, ctx }: { page: PanelThing; ctx: PanelContext }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const { busy, run } = useUndo();
  return (
    <OneCard>
      <ActivityPage
        page={page}
        before={null}
        last={cursors.length === 0}
        onMore={(c) => setCursors([c])}
        busy={busy}
        onUndo={run}
        ctx={ctx}
      />
      {cursors.map((c, i) => (
        <ActivityPage
          key={c}
          page={page}
          before={c}
          last={i === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
          busy={busy}
          onUndo={run}
          ctx={ctx}
        />
      ))}
    </OneCard>
  );
}

function ActivityPage({
  page,
  before,
  last,
  onMore,
  busy,
  onUndo,
  ctx,
}: {
  page: PanelThing;
  before: string | null;
  last: boolean;
  onMore: (cursor: string) => void;
  busy: string | null;
  onUndo: (change: ChangeEntry) => void;
  ctx: PanelContext;
}) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const list = useChanges(
    {
      params: { burrow: slug },
      query: { thing: page.id, limit: ACTIVITY_PAGE, ...(before ? { before } : {}) },
    },
    { retry: false },
  );
  const here = thingPageHref(page.id);
  const rows = useMemo(
    () => doneRows(list.data?.changes ?? [], now, timeZone, { here }),
    [list.data, now, timeZone, here],
  );
  if (list.isPending)
    return <SkeletonRows count={before ? 2 : 4} lines={2} label={tMobile('screens.loading-what-changed')} />;
  if (!list.data)
    return before ? null : (
      <ErrorState text={thingPageCopyHere.activityFailed} onRetry={() => void list.refetch()} />
    );
  if (!before && !rows.length) return <QuietText>{thingPageCopyHere.activityEmpty(page.name)}</QuietText>;
  const next = list.data.before;
  return (
    <>
      {rows.map((r, i) => (
        <ChangeRow
          key={r.id}
          row={r}
          first={!before && i === 0}
          busy={busy === r.id}
          onUndo={() => onUndo(r.change)}
          onReview={(href) => ctx.run({ kind: 'href', href })}
        />
      ))}
      {last && next ? (
        <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
          <Button label={thingPageCopyHere.showOlder} variant="quiet" onPress={() => onMore(next)} />
        </View>
      ) : null}
    </>
  );
}
