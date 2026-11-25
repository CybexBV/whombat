import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import {
  agentFaceOf,
  askText,
  NEEDS_YOU_WORDS,
  NeedsNewerAppError,
  type NeedsYouApprovalCard,
  type NeedsYouButton,
  type NeedsYouGlyph,
  type NeedsYouListGroupView,
  type NeedsYouListRow,
  needsYouApprovalCard,
  needsYouButtonGoes,
  needsYouIntent,
  needsYouListIntent,
  needsYouListView,
  needsYouMore,
  needsYouSettledText,
  startedChatPath,
  TEAM_REPORT_WORDS,
  teamReportDraftOfHref,
  teamReportDraftPath,
  threadToOpen,
} from '@whombat/client';
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { queryKeys } from '@whombat/client/query';
import {
  useBringBackWatch,
  useDiscussNeedsYou,
  useHandleLook,
  useHomeOverview,
  useIgnoreNeedsYou,
  useStartChat,
  useStopWatchingNeedsYou,
  useTheAgent,
} from '@whombat/client/react';
import type { AgentFace } from '@whombat/core';
import { isBackupPasskeyHref } from '@whombat/protocol/session';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Inbox,
  type LucideIcon,
  MessageCircleQuestion,
  Plug,
  Power,
  Server,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import { LoadErrorNote } from '../../app/runtime';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { useToast } from '../../components/Toast';
import { useBackupPasskeyTap } from '../../managed/backupPasskey';
import { AskCard } from '../approvals/AskCard';
import { useAskToCheck, useUnknownAnswer } from '../approvals/unknownAnswer';
import { AppLink } from '../files/AppLink';
import home from '../home/Home.module.css';
import { LookSays } from '../home/LookSays';
import { useNeedsYouActions } from '../home/useHomeActions';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { MenuButton } from '../things/manage/MenuButton';
import { useThingLinkProps } from '../things/prefetch';
import styles from './NeedsYouScreen.module.css';

export interface NeedsYouScreenProps {
  burrow: string;
}

const GLYPHS: Record<NeedsYouGlyph, LucideIcon> = {
  alert: TriangleAlert,
  power: Power,
  skill: Star,
  question: MessageCircleQuestion,
  connection: Plug,
  server: Server,
};

/**
 * The Inbox (`/inbox`; Whombat inbox.md IBX-01…, needs-you-list.md NYL-01…NYL-09): the one list of what needs the
 * person, in the shared groups (`needsYouListView`) — **Needs you** (the only one that counts: the sidebar's badge),
 * **{assistant}’s on it** (its face says it is looking), **Heads-ups** folded under one row, **Later** with Bring it back
 * and **Settled** pinned to the bottom of the screen (inbox.md IBX-09). A row is Connections' slim line: its
 * glyph, the title in bold with its detail after a “·”, where and when under it, what the assistant says by its face,
 * and its buttons — its way forward and ✓ Settle, then its ⋯ More (Ask {assistant} to handle it, Talk to {assistant}
 * about it, Remind me tomorrow, Stop watching this). `?item=` (a push, a link) scrolls to that item and marks it. Live
 * through `home.changed`.
 */
export function NeedsYouScreen({ burrow }: NeedsYouScreenProps) {
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const { data, error, refetch, isRefetchError } = useHomeOverview({ params: { burrow } });
  const navigateHref = useNavigateHref();
  const { agent, words } = useTheAgent(burrow);
  const view = useMemo(
    () => (data ? needsYouListView(data, { now, timeZone, assistant: words.name }) : null),
    [data, now, timeZone, words.name],
  );
  const focus = useRouterState({
    select: (s) => {
      const item = (s.location.search as Record<string, unknown>).item;
      return typeof item === 'string' ? item : null;
    },
  });
  const act = useListActions(burrow, timeZone, words);
  const face = agentFaceOf(agent);
  const youEmpty = view ? !view.groups.some((g) => g.key === 'you') : false;
  // Settled is pinned to the bottom of the screen (inbox.md IBX-09); the rest scrolls above it.
  const settled = view?.groups.find((g) => g.key === 'settled') ?? null;
  const listed = view?.groups.filter((g) => g.key !== 'settled') ?? [];

  return (
    <div className={styles.screen} data-screen="inbox">
      <div className={home.scroll}>
        <div className={cx(home.main, styles.page)}>
          <div className={styles.titleText}>
            <h1>{NEEDS_YOU_WORDS.title}</h1>
            <p>{NEEDS_YOU_WORDS.subtitle(words)}</p>
          </div>
          {error && !data ? (
            error instanceof NeedsNewerAppError ? (
              <LoadErrorNote error={error} message={NEEDS_YOU_WORDS.readFailed} />
            ) : (
              <ReadProblem
                title={NEEDS_YOU_WORDS.readFailed}
                body={NEEDS_YOU_WORDS.noSaved}
                error={error}
                name={words.name}
                onRetry={() => void refetch()}
                onAsk={act.askAboutRead}
              />
            )
          ) : !view ? (
            <section
              className={cx(home.card, styles.readState)}
              role="status"
              aria-label={NEEDS_YOU_WORDS.loading}
            >
              <p className={styles.readBody}>{NEEDS_YOU_WORDS.loading}</p>
              <SkeletonRows count={3} />
            </section>
          ) : (
            <>
              {isRefetchError ? (
                <ReadProblem
                  title={NEEDS_YOU_WORDS.refreshFailed}
                  body={NEEDS_YOU_WORDS.saved}
                  error={error}
                  name={words.name}
                  onRetry={() => void refetch()}
                  onAsk={act.askAboutRead}
                />
              ) : null}
              {view.empty ? (
                <section className={cx(home.card, styles.readState)} data-needs-you="empty">
                  <span className={styles.emptyIcon} aria-hidden="true">
                    <Icon icon={Inbox} size={24} />
                  </span>
                  <h2 className={styles.readTitle}>{NEEDS_YOU_WORDS.empty}</h2>
                  <p className={styles.readBody}>{NEEDS_YOU_WORDS.emptyBody}</p>
                  <div className={styles.recovery}>
                    <button type="button" className={styles.btn} onClick={() => navigateHref('/chat')}>
                      {NEEDS_YOU_WORDS.backToChat}
                    </button>
                  </div>
                </section>
              ) : youEmpty ? (
                <section className={cx(home.card, styles.empty)} data-needs-you="empty">
                  <Icon icon={Check} size={18} />
                  <p>{NEEDS_YOU_WORDS.nothing}</p>
                </section>
              ) : null}
              {listed.map((group) => (
                <Group
                  key={group.key}
                  group={group}
                  burrow={burrow}
                  timeZone={timeZone}
                  face={face}
                  name={words.name}
                  focus={focus}
                  busy={act.busy}
                  onPress={act.press}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {settled ? (
        <SettledBar
          group={settled}
          burrow={burrow}
          timeZone={timeZone}
          face={face}
          name={words.name}
          focus={focus}
          busy={act.busy}
          onPress={act.press}
        />
      ) : null}
    </div>
  );
}

/**
 * Settled, pinned to the bottom of the screen (inbox.md IBX-09): one flush 44px bar under the list, “Settled · 3”, which
 * opens upward into its rows (their own scroll, at most about half the screen), or, with nothing settled, into the line
 * that says what it is for. It sits below the list, never over a row. A link to a settled item (`?item=`) opens it.
 */
function SettledBar({
  group,
  burrow,
  timeZone,
  face,
  name,
  focus,
  busy,
  onPress,
}: {
  group: NeedsYouListGroupView;
  burrow: string;
  timeZone: string;
  face: AgentFace;
  name: string;
  focus: string | null;
  busy: string | null;
  onPress: (row: NeedsYouListRow, button: NeedsYouButton) => void;
}) {
  const holdsFocus = group.rows.some((r) => r.id === focus);
  const [open, setOpen] = useState(holdsFocus);
  useEffect(() => {
    if (holdsFocus) setOpen(true);
  }, [holdsFocus]);
  const empty = group.rows.length === 0;
  const id = 'needs-you-settled';
  return (
    <section
      className={styles.settled}
      aria-label={group.label}
      data-needs-you-group={group.key}
      data-open={open || undefined}
    >
      {open ? (
        <div id={`${id}-rows`} className={styles.settledBody}>
          {empty ? (
            <p className={cx(styles.settledInner, styles.settledNone)}>{NEEDS_YOU_WORDS.noneSettled}</p>
          ) : (
            <div className={cx(styles.settledInner, styles.rows)}>
              {group.rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  burrow={burrow}
                  timeZone={timeZone}
                  face={face}
                  name={name}
                  focused={row.id === focus}
                  busy={busy === row.id}
                  onPress={(b) => onPress(row, b)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className={styles.settledBar}>
        <button
          type="button"
          className={styles.settledHead}
          aria-expanded={open}
          aria-controls={`${id}-rows`}
          onClick={() => setOpen(!open)}
        >
          <span className={styles.settledTitle}>{group.label}</span>
          {/* No “0”: an empty Settled is just its name. */}
          {empty ? null : (
            <>
              <span className={styles.settledDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.settledCount}>{group.rows.length}</span>
            </>
          )}
          <span className={styles.spacer} />
          {!empty ? (
            <span className={styles.settledFold}>{open ? group.fold?.hide : group.fold?.show}</span>
          ) : null}
          <Icon icon={open ? ChevronDown : ChevronUp} size={15} />
        </button>
      </div>
    </section>
  );
}

/** A group's card: its heading and count, its rows; Heads-ups and Settled folded under one row until opened. */
function Group({
  group,
  burrow,
  timeZone,
  face,
  name,
  focus,
  busy,
  onPress,
}: {
  group: NeedsYouListGroupView;
  burrow: string;
  timeZone: string;
  face: AgentFace;
  name: string;
  focus: string | null;
  busy: string | null;
  onPress: (row: NeedsYouListRow, button: NeedsYouButton) => void;
}) {
  const holdsFocus = group.rows.some((r) => r.id === focus);
  // Unfolded by the person (or a link to one of its rows); until then as the group says, so an empty Settled that gets
  // its first row folds it.
  const [opened, setOpened] = useState<boolean | null>(holdsFocus ? true : null);
  useEffect(() => {
    if (holdsFocus) setOpened(true);
  }, [holdsFocus]);
  const open = opened ?? !group.folded;
  const id = `needs-you-${group.key}`;
  return (
    <section className={cx(home.card, styles.group)} aria-labelledby={id} data-needs-you-group={group.key}>
      <header className={styles.head}>
        <h2 id={id}>{group.label}</h2>
        {group.rows.length ? <span className={styles.count}>{group.rows.length}</span> : null}
      </header>
      {group.fold ? (
        <button
          type="button"
          className={styles.fold}
          aria-expanded={open}
          aria-controls={`${id}-rows`}
          onClick={() => setOpened(!open)}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={15} />
          {open ? group.fold.hide : group.fold.show}
        </button>
      ) : null}
      {open ? (
        <div id={`${id}-rows`} className={styles.rows}>
          {group.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              burrow={burrow}
              timeZone={timeZone}
              face={face}
              name={name}
              focused={row.id === focus}
              busy={busy === row.id}
              onPress={(b) => onPress(row, b)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Row({
  row,
  burrow,
  timeZone,
  face,
  name,
  focused,
  busy,
  onPress,
}: {
  row: NeedsYouListRow;
  burrow: string;
  timeZone: string;
  face: AgentFace;
  name: string;
  focused: boolean;
  busy: boolean;
  onPress: (button: NeedsYouButton) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const passkey = useBackupPasskeyTap();
  const hasPasskey = row.buttons.some((b) => isPasskeyButton(row.item.href, b));
  const linkProps = useThingLinkProps(burrow);
  // A push or a link that names it: in view, marked.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const fixed = row.says?.fixed ?? false;
  // What isn't working has the one loud cue, its tile; everything else is calm.
  const bad = !fixed && row.group === 'you' && row.tone === 'bad';
  const shown = row.buttons.filter((b) => !b.more);
  const more = needsYouMore(row);
  const headId = `need-${row.id}`;
  const meta = [row.meta, row.state].filter(Boolean).join(' · ');
  // An approval is the one approval card, its facts and exact later time before its answers (approval-card.md).
  const card = row.group === 'you' ? needsYouApprovalCard(row, { timeZone, assistant: name }) : null;
  if (card)
    return (
      <ApprovalRow
        ref={ref}
        row={row}
        burrow={burrow}
        card={card}
        focused={focused}
        busy={busy}
        onPress={onPress}
      />
    );
  return (
    <article
      ref={ref}
      className={styles.row}
      aria-labelledby={headId}
      data-needs-you-item={row.id}
      data-research={row.says ? row.says.state : undefined}
      data-tone={bad ? 'bad' : fixed ? 'ok' : undefined}
      data-focused={focused || undefined}
    >
      <div className={styles.tile} aria-hidden="true">
        <Icon icon={fixed ? Check : bad ? TriangleAlert : GLYPHS[row.glyph]} size={16} />
      </div>
      <div className={styles.text}>
        <h3 id={headId} className={styles.title}>
          {row.href ? (
            <AppLink href={row.href} {...linkProps(row.href)} className={styles.titleLink}>
              {hasPasskey ? (passkey?.view?.title ?? row.title) : row.title}
            </AppLink>
          ) : hasPasskey ? (
            (passkey?.view?.title ?? row.title)
          ) : (
            row.title
          )}
        </h3>
        {row.body ? <p className={styles.body}>{row.body}</p> : null}
        {meta ? <p className={styles.meta}>{meta}</p> : null}
        {hasPasskey && passkey?.note ? (
          <p className={styles.feedback} role="status">
            {passkey.note}
          </p>
        ) : null}
        {row.says ? <LookSays view={row.says} face={face} name={name} className={styles.says} /> : null}
      </div>
      {row.buttons.length ? (
        <div className={styles.actions} data-row-actions="">
          {shown.map((b) => (
            <button
              key={b.id}
              type="button"
              className={cx(
                styles.btn,
                b.look === 'primary' && styles.primary,
                b.look === 'quiet' && styles.quiet,
              )}
              disabled={
                busy ||
                (isPasskeyButton(row.item.href, b) &&
                  !!passkey &&
                  (passkey.busy || (!passkey.view && !passkey.loadError)))
              }
              onClick={() => onPress(b)}
            >
              {b.kind === 'settle' ? <Icon icon={Check} size={15} /> : null}
              {isPasskeyButton(row.item.href, b) && passkey ? passkey.label : b.label}
            </button>
          ))}
          {more.length ? (
            <MenuButton
              label={`${NEEDS_YOU_WORDS.more} for ${row.title}`}
              className={cx(styles.btn, styles.more)}
              disabled={busy}
              items={more.map((b) => ({ label: b.label, onSelect: () => onPress(b) }))}
            >
              <Icon icon={Ellipsis} size={16} />
            </MenuButton>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** An approval in the Inbox: the approval card with the row's answers, and its More under it. */
function ApprovalRow({
  ref,
  row,
  burrow,
  card,
  focused,
  busy,
  onPress,
}: {
  ref: RefObject<HTMLElement | null>;
  row: NeedsYouListRow;
  burrow: string;
  card: NeedsYouApprovalCard;
  focused: boolean;
  busy: boolean;
  onPress: (button: NeedsYouButton) => void;
}) {
  const more = needsYouMore(row);
  const number = row.item.approvalNumber;
  const mayHaveGoneThrough = useUnknownAnswer(burrow, number);
  const check = useAskToCheck(burrow, row.title);
  const updateSearch = useSearchUpdate();
  // The assistant's draft report: Edit opens the form with it, as on its card in Chat. Too long to read here, it
  // offers no yes: Open approval shows all of it, where it can be sent, beside the answers (as on the phone).
  const draftId = teamReportDraftOfHref(row.item.href);
  const navigate = useNavigateHref();
  const openApproval =
    draftId && number && !row.buttons.some((b) => b.action?.kind === 'approve')
      ? {
          id: 'open_approval',
          label: NEEDS_YOU_WORDS.openApproval,
          onSelect: () => void updateSearch((prev) => ({ ...prev, approval: number })),
        }
      : null;
  return (
    <article
      ref={ref}
      className={cx(styles.row, styles.approvalRow)}
      aria-label={row.title}
      data-needs-you-item={row.id}
      data-focused={focused || undefined}
    >
      <AskCard
        level={3}
        facts={card}
        pending
        busy={busy}
        answers={[
          ...row.buttons
            .filter((b) => !b.more)
            .map((b) => ({ id: b.id, label: b.label, onSelect: () => onPress(b) })),
          ...(openApproval ? [openApproval] : []),
        ]}
        unknown={mayHaveGoneThrough ? check : null}
        className={styles.approvalCard}
        edit={
          draftId
            ? { label: TEAM_REPORT_WORDS.edit, href: teamReportDraftPath(draftId), onNavigate: navigate }
            : undefined
        }
        details={
          number && !openApproval ? (
            <div>
              <button
                type="button"
                className={styles.btn}
                onClick={() => void updateSearch((prev) => ({ ...prev, approval: number }))}
              >
                {NEEDS_YOU_WORDS.openApproval}
              </button>
            </div>
          ) : null
        }
      />
      {more.length ? (
        <div className={styles.approvalMore} data-row-actions="">
          <MenuButton
            label={`${NEEDS_YOU_WORDS.more} for ${row.title}`}
            className={cx(styles.btn, styles.more)}
            disabled={busy}
            items={more.map((b) => ({ label: b.label, onSelect: () => onPress(b) }))}
          >
            <Icon icon={Ellipsis} size={16} />
          </MenuButton>
        </div>
      ) : null}
    </article>
  );
}

/** The list couldn't be read (or refreshed): what shows, Try again (it only reads), Ask {assistant}, More detail. */
function ReadProblem({
  title,
  body,
  error,
  name,
  onRetry,
  onAsk,
}: {
  title: string;
  body: string;
  error: unknown;
  name: string;
  onRetry: () => void;
  onAsk: () => void;
}) {
  const detail = error instanceof Error ? error.message : null;
  return (
    <section className={cx(home.card, styles.readState)} role="status">
      <h2 className={cx(styles.readTitle, styles.problem)}>{title}</h2>
      <p className={styles.readBody}>{body}</p>
      <div className={styles.recovery}>
        <button type="button" className={styles.btn} onClick={onRetry}>
          {NEEDS_YOU_WORDS.retry}
        </button>
        <button type="button" className={styles.btn} onClick={onAsk}>
          {NEEDS_YOU_WORDS.ask({ name })}
        </button>
      </div>
      {detail ? (
        <details className={styles.detail}>
          <summary>{NEEDS_YOU_WORDS.moreDetail}</summary>
          <p>{detail}</p>
        </details>
      ) : null}
    </section>
  );
}

function isPasskeyButton(href: string | null | undefined, button: NeedsYouButton): boolean {
  const target = button.kind === 'see' ? href : button.action?.kind === 'open' ? button.action.href : null;
  return !!target && isBackupPasskeyHref(target);
}

const SOMETHING_WENT_WRONG = NEEDS_YOU_WORDS.failed;
/** A refusal's words stay up long enough to read. */
const FAILED_TOAST_MS = 6000;
/** Settle's Undo stays a little longer than other toasts: the row has just gone, the person may want it back. */
const SETTLE_TOAST_MS = 8000;

/**
 * Where focus goes once a row leaves the list: the first button of the row after it (or before it, at the end), so a
 * keyboard can settle one row after another.
 */
function focusAfter(id: string): () => void {
  const at = (key: string) => document.querySelector(`[data-needs-you-item="${CSS.escape(key)}"]`);
  const row = at(id);
  const next = (row?.nextElementSibling ?? row?.previousElementSibling)?.getAttribute('data-needs-you-item');
  return () => {
    const target = next ? at(next) : null;
    (
      target?.querySelector<HTMLElement>('[data-row-actions] button') ??
      target?.querySelector<HTMLElement>('a')
    )?.focus();
  };
}

/**
 * What the list's buttons do: Needs you's own (approve, tonight, decline, open, Remind me tomorrow, the step) through
 * Home's actions; Settle with Undo; *Ask {assistant} to handle it* (the thing handed over, `looks.handle`; with nothing
 * to look into there, the question in the thing's own thread); *Talk to {assistant} about it* (a thread it opens with
 * the item, `needsYou.discuss`; an older Whombat: the question in the thing's thread); Stop watching this (with Undo);
 * Bring it back.
 */
function useListActions(burrow: string, timeZone: string, words: { name: string; Name: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigateHref = useNavigateHref();
  const backupPasskey = useBackupPasskeyTap();
  const actions = useNeedsYouActions(burrow, timeZone);
  const start = useStartChat(burrow);
  const back = useBringBackWatch(burrow);
  const stopWatching = useStopWatchingNeedsYou(burrow);
  const settling = useIgnoreNeedsYou(burrow);
  const discuss = useDiscussNeedsYou(burrow);
  // Handed over: the row moves to the assistant's group at once; with nothing to look into, the question instead.
  const handling = useRef<{ text: string; subject: NeedsYouListRow['item']['subject'] } | null>(null);
  // Handed over: its thread opens, where the assistant works on it (backup-places.md BPL-15); without one, a toast.
  const handle = useHandleLook(burrow, (outcome, thread) => {
    const asked = handling.current;
    handling.current = null;
    setBusy(null);
    const open = outcome === 'ok' ? threadToOpen(thread) : null;
    if (open) navigateHref(open);
    else if (outcome === 'ok') toast.show(NEEDS_YOU_WORDS.handling(words));
    else if (outcome === 'ask' && asked) void ask(asked.text, asked.subject ?? null);
    else toast.show(SOMETHING_WENT_WRONG);
  });
  const [busy, setBusy] = useState<string | null>(null);

  /** The question in the thing's own thread (a new one only when it has none), then that thread. */
  const ask = async (text: string, subject: NeedsYouListRow['item']['subject'] | null) => {
    const result = await start.mutateAsync({ text, subject, reuseThread: true });
    if (result.status === 'ok') navigateHref(startedChatPath(result.data));
    else toast.show(SOMETHING_WENT_WRONG);
  };

  const press = (row: NeedsYouListRow, button: NeedsYouButton) => {
    const { item } = row;
    if (backupPasskey && isPasskeyButton(item.href, button)) {
      void backupPasskey();
      return;
    }
    const intent = needsYouListIntent(item, button, Date.now(), timeZone);
    if (!intent) return;
    // What hands work over waits on its row until its thread opens (backup-places.md BPL-15).
    const toThread = needsYouButtonGoes(button) === 'thread';
    switch (intent.type) {
      case 'fix':
        if (item.research) actions.fix(item.research, row.id);
        return;
      case 'open':
        // Setup stays in this click so the browser can open its passkey prompt.
        if (backupPasskey && isBackupPasskeyHref(intent.href)) {
          void backupPasskey().then(({ note }) => note && toast.show(note));
          return;
        }
        navigateHref(intent.href);
        return;
      case 'action':
        void actions.run(row.id, item.ref, needsYouIntent(item, intent.action, Date.now(), timeZone));
        return;
      case 'snooze':
        void actions.run(row.id, item.ref, { type: 'snooze', ref: intent.ref, until: intent.until });
        return;
      case 'handle':
        handling.current = { text: intent.text, subject: intent.subject };
        if (toThread) setBusy(row.id);
        handle.mutate(intent.key);
        return;
      case 'ask':
      case 'talk':
      case 'settle':
      case 'back':
      case 'stop':
        break;
    }
    setBusy(row.id);
    const run = async () => {
      switch (intent.type) {
        case 'settle': {
          const { ref } = intent;
          const moveFocus = focusAfter(row.id);
          const settled = settling.mutateAsync({ ref, ignored: true });
          moveFocus();
          const result = await settled;
          if (result.status !== 'ok') {
            toast.show(commitOutcomeText(result) ?? SOMETHING_WENT_WRONG, { duration: FAILED_TOAST_MS });
            return;
          }
          toast.show(needsYouSettledText(ref), {
            duration: SETTLE_TOAST_MS,
            action: {
              label: NEEDS_YOU_WORDS.undo,
              onAction: () =>
                void settling.mutateAsync({ ref, ignored: false }).then(
                  (r) => r.status !== 'ok' && toast.show(SOMETHING_WENT_WRONG),
                  () => toast.show(SOMETHING_WENT_WRONG),
                ),
            },
          });
          return;
        }
        case 'stop': {
          const { watch } = intent;
          const result = await stopWatching.mutateAsync({ ref: item.ref, watch, watched: false });
          if (result.status !== 'ok') {
            toast.show(commitOutcomeText(result) ?? SOMETHING_WENT_WRONG, { duration: FAILED_TOAST_MS });
            return;
          }
          toast.show(NEEDS_YOU_WORDS.stopped(watch.name), {
            action: {
              label: NEEDS_YOU_WORDS.undo,
              onAction: () =>
                void stopWatching
                  .mutateAsync({ ref: item.ref, watch, watched: true })
                  .then((r) => {
                    if (r.status !== 'ok') toast.show(commitOutcomeText(r) ?? SOMETHING_WENT_WRONG);
                  })
                  .catch((error: unknown) => toast.show(hostErrorInfo(error).message)),
            },
          });
          return;
        }
        case 'ask':
          await ask(intent.text, intent.subject);
          return;
        case 'talk': {
          // A Whombat without it (or an item that just went): the question in the thing's own thread instead.
          const result = await discuss.mutateAsync({ ref: intent.ref }).catch(() => null);
          if (result?.status === 'ok') navigateHref(startedChatPath(result.data));
          else await ask(askText(item), item.subject ?? null);
          return;
        }
        case 'back': {
          const result = await back.mutateAsync({ ref: intent.ref });
          toast.show(result.status === 'ok' ? NEEDS_YOU_WORDS.backDone : SOMETHING_WENT_WRONG);
          void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
          return;
        }
      }
    };
    run()
      .catch(() => toast.show(SOMETHING_WENT_WRONG))
      .finally(() => setBusy(null));
  };

  /** *Ask {assistant}* when the list couldn't be read: a question in a new thread, nothing else sent. */
  const askAboutRead = () =>
    void ask(NEEDS_YOU_WORDS.readFailedAsk, null).catch(() => toast.show(SOMETHING_WENT_WRONG));

  return { press, askAboutRead, busy: busy ?? actions.busy };
}
