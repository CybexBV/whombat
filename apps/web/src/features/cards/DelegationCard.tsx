import {
  CARD_FRAME_WORDS,
  type CardFrame as CardFrameData,
  DELEGATION_AI_WORDS,
  DELEGATION_WORDS,
  type DelegationCardView,
  type DelegationItemView,
  type DelegationTaskView,
  delegationCardView,
  delegationFrame,
  sameDelegationAi,
} from '@whombat/client';
import { useApiMutation } from '@whombat/client/react';
import { appErrorOf } from '@whombat/client/signins';
import type {
  Attachment,
  DelegationAi,
  DelegationCard as DelegationCardData,
  DelegationCardTask,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { Check, ChevronDown, Ellipsis } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ContextMenuItem } from '../../app/shell/ContextMenu';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { outcomeText, refusalText } from '../conversations/refusal';
import { useTicker } from '../messaging/useRoom';
import { MenuButton } from '../things/manage/MenuButton';
import { CardFrame, cardMenuLabel, DetailsHeading, FootButton, FrameButton, frameStyles } from './CardFrame';
import c from './CouncilCard.module.css';
import { useCardStill } from './cardLook';
import { DelegationAiMenu } from './DelegationAiMenu';
import d from './DelegationCard.module.css';
import { focusReplyNear } from './LookPlanCard';
import { ShotPictures } from './ShotPictures';

export interface DelegationCardProps {
  burrow: string;
  card: DelegationCardData;
  /** The message's files: the tasks' pictures of what changed are among them (the message's own strip leaves them out). */
  attachments?: readonly Attachment[];
  /** The assistant's name (the card message's author), for a question it answers itself: “Asked Dusty”. */
  lead?: string | null;
}

/**
 * Coding tasks the agent hands to T3 Code (Whombat delegate.md), in the cards' one layout
 * (docs/decisions/chat-threads-cards.md). While it waits: Waiting for you, its title, “Pick what to hand over · 3 of 4
 * ticked”, the checklist (each task with its checkbox, its reason and whether it starts after another), then Hand over N
 * (its arrow chooses the AI for every task), Change something and Not now; the AI of each task is under Details. Once
 * handed over: Handed over, how far it is (“2 finished · 6 still in progress”), a short row per task that works, waits or
 * needs a look, the finished ones folded into one line (DLG-28), Open tasks and Stop (it asks first). Open tasks opens
 * Details: each task's record — what it does now, how long it worked, the AI on it, the agent's line, its pull request,
 * its pictures and a ⋯ menu (Open in T3 Code, Stop this task). Every word comes from `delegationFrame`,
 * `delegationCardView` and `DELEGATION_WORDS`, which the phone shares.
 */
export function DelegationCard({ burrow, card: sent, attachments, lead = null }: DelegationCardProps) {
  // A copy of the card as it was (card-moves.md) keeps still: its clocks would count on from long ago.
  const still = useCardStill();
  const working = sent.live && sent.tasks.some((t) => t.state === 'working');
  const now = useTicker(working && !still);
  const picks = usePicks(burrow, sent);
  const held = useHeldAi(picks.card);
  const card = held.card;
  const view = delegationCardView(card, now, lead);
  const frame = delegationFrame(card, still);
  const data = { 'data-variant': card.live ? 'live' : 'final', 'data-stage': card.stage };
  return view.offer ? (
    <Checklist
      burrow={burrow}
      card={card}
      view={view}
      frame={frame}
      data={data}
      onPick={picks.pick}
      onChosen={held.hold}
    />
  ) : (
    <Progress
      burrow={burrow}
      card={card}
      view={view}
      frame={frame}
      data={data}
      attachments={attachments ?? []}
    />
  );
}

type FrameData = Record<`data-${string}`, string>;

/* The checklist --------------------------------------------------------------------------------------------------- */

function Checklist({
  burrow,
  card,
  view,
  frame,
  data,
  onPick,
  onChosen,
}: {
  burrow: string;
  card: DelegationCardData;
  view: DelegationCardView;
  frame: CardFrameData;
  data: FrameData;
  onPick: (taskId: string, picked: boolean) => void;
  onChosen: (taskId: string | null, ai: DelegationAi | null) => void;
}) {
  const press = useDelegationPress(burrow, card);
  const [choosing, setChoosing] = useState<{ taskId: string | null; anchor: HTMLElement } | null>(null);
  const open = useRef(choosing);
  open.current = choosing;
  // Escape and Done give focus back to the button that opened the menu.
  const close = useCallback((restore: boolean) => {
    const was = open.current;
    setChoosing(null);
    if (restore) was?.anchor.focus();
  }, []);
  const toggle = (taskId: string | null, anchor: HTMLElement) =>
    setChoosing((was) => (was && was.taskId === taskId ? null : { taskId, anchor }));
  const chosenTask = choosing?.taskId ? card.tasks.find((t) => t.id === choosing.taskId) : undefined;
  return (
    <CardFrame
      card="delegation"
      frame={frame}
      className={c.card}
      data={data}
      content={
        <>
          {view.tasks.length > 0 && (
            <ul className={d.members}>
              {view.tasks.map((t) => (
                <PickRow
                  key={t.id}
                  task={t}
                  after={card.tasks.find((x) => x.id === t.id)?.after ?? null}
                  onPick={onPick}
                />
              ))}
            </ul>
          )}
          {view.aiSummary && <span className={d.aiSummary}>{view.aiSummary}</span>}
        </>
      }
      actions={
        <>
          {view.aiChoosable ? (
            <span className={d.split}>
              <Button
                variant="primary"
                size="md"
                className={d.splitMain}
                disabled={press.busy || view.picked === 0 || view.held}
                onClick={() => void press.start()}
              >
                {view.handOver}
              </Button>
              <Button
                variant="primary"
                size="md"
                className={d.splitArrow}
                aria-label={DELEGATION_AI_WORDS.openAll(view.ai)}
                aria-haspopup="dialog"
                aria-expanded={choosing !== null && choosing.taskId === null}
                disabled={press.busy || view.held}
                onClick={(e) => toggle(null, e.currentTarget)}
                data-delegation-ai-all=""
              >
                <Icon icon={ChevronDown} size={14} />
              </Button>
            </span>
          ) : (
            <FrameButton
              main
              disabled={press.busy || view.picked === 0 || view.held}
              onClick={() => void press.start()}
            >
              {view.handOver}
            </FrameButton>
          )}
          <FrameButton onClick={(e) => focusReplyNear(e.currentTarget)}>
            {DELEGATION_WORDS.change}
          </FrameButton>
          <FrameButton disabled={press.busy} onClick={() => void press.stop()}>
            {DELEGATION_WORDS.notNow}
          </FrameButton>
        </>
      }
      details={
        <>
          {view.project && (
            <dl className={frameStyles.facts}>
              <dt>Project</dt>
              <dd>{view.project}</dd>
            </dl>
          )}
          {view.aiChoosable && view.tasks.length > 0 && (
            <>
              <DetailsHeading>{CARD_FRAME_WORDS.aiPerTask}</DetailsHeading>
              <ul className={d.aiRows}>
                {view.tasks.map((t) => (
                  <li key={t.id} className={d.aiRow}>
                    <span className={d.aiRowTitle}>
                      <span className={d.n}>{t.n}</span> {t.title}
                    </span>
                    <button
                      type="button"
                      className={cx(d.aiChip, t.ai && d.aiChipSet)}
                      aria-label={DELEGATION_AI_WORDS.openTask(t.title, t.ai)}
                      aria-haspopup="dialog"
                      aria-expanded={choosing?.taskId === t.id}
                      onClick={(e) => toggle(t.id, e.currentTarget)}
                      data-delegation-ai-task={t.n}
                    >
                      <span className={d.aiChipText}>{t.ai ?? DELEGATION_AI_WORDS.chipDefault}</span>
                      <Icon icon={ChevronDown} size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      }
      after={
        choosing && (
          <DelegationAiMenu
            key={choosing.taskId ?? 'all'}
            burrow={burrow}
            card={card}
            task={chosenTask ? { id: chosenTask.id, n: chosenTask.n, title: chosenTask.title } : undefined}
            current={chosenTask ? chosenTask.ai : card.ai}
            subtitle={chosenTask ? null : DELEGATION_AI_WORDS.allCount(view.aiShared, view.picked)}
            anchor={choosing.anchor}
            onClose={close}
            onChosen={(ai) => onChosen(choosing.taskId, ai)}
          />
        )
      }
    />
  );
}

/** A task on the checklist: its checkbox, number and title (both tick it), its reason, and “After 1” at the end. */
function PickRow({
  task: t,
  after,
  onPick,
}: {
  task: DelegationTaskView;
  after: number | null;
  onPick: (taskId: string, picked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className={cx(d.member, d.task, !t.picked && d.unpicked)} data-task={t.id}>
      <span className={d.box}>
        <input
          id={id}
          type="checkbox"
          className={d.check}
          checked={t.picked}
          aria-label={DELEGATION_WORDS.tick(t.title)}
          onChange={(e) => onPick(t.id, e.currentTarget.checked)}
        />
      </span>
      <label htmlFor={id} className={cx(d.who, d.pickable)}>
        <span className={d.line}>
          <span className={d.n}>{t.n}</span>
          <span className={cx(d.name, d.title)}>{t.title}</span>
        </span>
        {t.why && <span className={d.why}>{t.why}</span>}
        {/* At a phone's width “After 1” goes under the reason, so the title keeps the row's width. */}
        {after !== null && <span className={d.afterUnder}>{DELEGATION_WORDS.after(after)}</span>}
      </label>
      <span className={cx(d.status, d.afterBeside)}>
        {after !== null ? DELEGATION_WORDS.after(after) : null}
      </span>
      <span />
    </li>
  );
}

/**
 * Ticks show at once (the card's update follows on the socket): a tick the card doesn't have yet is kept here until it
 * does, and taken back with a quiet toast when it doesn't go through.
 */
function usePicks(burrow: string, sent: DelegationCardData) {
  const toast = useToast();
  const pick = useApiMutation(api.delegations.pick);
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The card caught up with a tick: it no longer needs keeping.
  useEffect(() => {
    setTicks((held) => {
      const left = new Map([...held].filter(([id, v]) => sent.tasks.find((t) => t.id === id)?.picked !== v));
      return left.size === held.size ? held : left;
    });
  }, [sent.tasks]);
  const card = useMemo<DelegationCardData>(
    () =>
      ticks.size === 0
        ? sent
        : {
            ...sent,
            tasks: sent.tasks.map(
              (t): DelegationCardTask => (ticks.has(t.id) ? { ...t, picked: ticks.get(t.id) as boolean } : t),
            ),
          },
    [sent, ticks],
  );
  const takeBack = (taskId: string, picked: boolean) =>
    setTicks((held) => {
      if (held.get(taskId) !== picked) return held;
      const left = new Map(held);
      left.delete(taskId);
      return left;
    });
  return {
    card,
    pick: (taskId: string, picked: boolean) => {
      setTicks((held) => new Map(held).set(taskId, picked));
      void (async () => {
        try {
          const r = await pick.mutateAsync({
            params: { burrow },
            body: { delegationId: sent.delegationId, taskId, picked },
          });
          if (r.status !== 'ok') {
            takeBack(taskId, picked);
            toast.show(outcomeText(r));
          }
        } catch (err) {
          takeBack(taskId, picked);
          toast.show(pressFailed(err, DELEGATION_WORDS.failed.pick));
        }
      })();
    },
  };
}

/**
 * An AI chosen in the menu shows at once: kept here (by task, '' for every task) until the card's own update brings it.
 */
function useHeldAi(sent: DelegationCardData) {
  const [held, setHeld] = useState<ReadonlyMap<string, DelegationAi | null>>(new Map());
  const onCard = (key: string) => (key ? sent.tasks.find((t) => t.id === key)?.ai : sent.ai);
  // The card caught up with a choice: it no longer needs keeping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card's own update is what releases a choice
  useEffect(() => {
    setHeld((was) => {
      const left = new Map([...was].filter(([key, ai]) => !sameDelegationAi(onCard(key), ai)));
      return left.size === was.size ? was : left;
    });
  }, [sent]);
  const card = useMemo<DelegationCardData>(() => {
    if (held.size === 0) return sent;
    return {
      ...sent,
      ...(held.has('') ? { ai: held.get('') ?? null } : {}),
      tasks: sent.tasks.map(
        (t): DelegationCardTask => (held.has(t.id) ? { ...t, ai: held.get(t.id) ?? null } : t),
      ),
    };
  }, [sent, held]);
  return {
    card,
    hold: (taskId: string | null, ai: DelegationAi | null) =>
      setHeld((was) => new Map(was).set(taskId ?? '', ai)),
  };
}

/* The progress ---------------------------------------------------------------------------------------------------- */

function Progress({
  burrow,
  card,
  view,
  frame,
  data,
  attachments,
}: {
  burrow: string;
  card: DelegationCardData;
  view: DelegationCardView;
  frame: CardFrameData;
  data: FrameData;
  attachments: readonly Attachment[];
}) {
  const press = useDelegationPress(burrow, card);
  const [asking, setAsking] = useState(false);
  const [askingTask, setAskingTask] = useState<DelegationTaskView | null>(null);
  // The menu's column is there only when some row has a menu, so an ended card's times stay at its edge.
  const all = [...view.tasks, ...(view.folded?.tasks ?? [])];
  const menus = all.some((t) => t.url || t.stoppable);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const row = (t: DelegationTaskView) => (
    <TaskRow
      key={t.id}
      task={t}
      attachments={attachments}
      menus={menus}
      busy={press.stoppingTask(t.id)}
      onStop={() => setAskingTask(t)}
    />
  );
  // On the card itself each task is one short row: its mark, its title and where it is, in words.
  const brief = (t: DelegationTaskView) => <BriefRow key={t.id} task={t} />;
  return (
    <CardFrame
      card="delegation"
      frame={frame}
      className={c.card}
      data={data}
      content={
        all.length > 0 && (
          <ul className={cx(d.members, d.brief)}>
            {view.tasks.map(brief)}
            {view.folded && <Folded label={view.folded.label}>{view.folded.tasks.map(brief)}</Folded>}
          </ul>
        )
      }
      actions={
        all.length > 0 ? (
          <FrameButton main aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
            {CARD_FRAME_WORDS.openTasks}
          </FrameButton>
        ) : null
      }
      // Stop steps back: a quiet word at the foot and in the ⋯ menu; it asks first.
      menu={
        view.stoppable ? (
          <MenuButton
            label={cardMenuLabel(card.title)}
            className={frameStyles.menuButton}
            items={[{ label: `${DELEGATION_WORDS.stop}…`, onSelect: () => setAsking(true) }]}
          >
            <Icon icon={Ellipsis} size={16} />
          </MenuButton>
        ) : undefined
      }
      foot={
        view.stoppable ? (
          <FootButton disabled={press.busy} onClick={() => setAsking(true)} data-delegation-stop="">
            {DELEGATION_WORDS.stop}
          </FootButton>
        ) : undefined
      }
      detailsOpen={detailsOpen}
      onDetailsToggle={setDetailsOpen}
      details={
        <>
          {view.project && (
            <dl className={frameStyles.facts}>
              <dt>Project</dt>
              <dd>{view.project}</dd>
            </dl>
          )}
          {all.length > 0 && (
            <>
              <DetailsHeading>{CARD_FRAME_WORDS.tasks}</DetailsHeading>
              {/* The list's own width decides its layout: on a narrow card where it is and how long sit under the title. */}
              <div className={d.room}>
                <ul className={cx(d.members, d.handed, menus && d.withMenu)}>{all.map(row)}</ul>
              </div>
            </>
          )}
        </>
      }
      after={
        <>
          <ConfirmDialog
            open={asking}
            onOpenChange={setAsking}
            kicker={DELEGATION_WORDS.name}
            title={DELEGATION_WORDS.stopAsk.title}
            confirmLabel={DELEGATION_WORDS.stop}
            cancelLabel={DELEGATION_WORDS.stopAsk.keep}
            busy={press.busy}
            onConfirm={() => {
              setAsking(false);
              void press.stop();
            }}
          >
            {DELEGATION_WORDS.stopAsk.body}
          </ConfirmDialog>
          <ConfirmDialog
            open={askingTask !== null}
            onOpenChange={(open) => !open && setAskingTask(null)}
            kicker={
              askingTask
                ? askingTask.items
                  ? askingTask.title
                  : `${askingTask.n}. ${askingTask.title}`
                : DELEGATION_WORDS.name
            }
            title={DELEGATION_WORDS.stopTaskAsk.title}
            confirmLabel={DELEGATION_WORDS.stop}
            cancelLabel={DELEGATION_WORDS.stopTaskAsk.keep}
            onConfirm={() => {
              const t = askingTask;
              setAskingTask(null);
              if (t) void press.stopTask(t.id);
            }}
          >
            {DELEGATION_WORDS.stopTaskAsk.body}
          </ConfirmDialog>
        </>
      }
    />
  );
}

/** A handed-over task on the card: its number (a turning ring while it works, a check once done), title and status. */
function BriefRow({ task: t }: { task: DelegationTaskView }) {
  const still = useCardStill();
  return (
    <li
      className={cx(d.member, d.task, t.muted && d.muted)}
      data-task={t.id}
      data-working={(t.working && !still) || undefined}
      data-done={t.done || undefined}
      data-attention={t.attention || undefined}
    >
      <span className={cx(d.slot, t.working && d.working, t.done && d.doneSlot)} aria-hidden="true">
        {t.working && <span className={d.ring} />}
        <span className={d.glyph}>{t.done ? <Icon icon={Check} size={14} /> : t.slot}</span>
      </span>
      <span className={d.who}>
        <span className={cx(d.name, d.title)}>{t.title}</span>
        <span className={cx(d.briefStatus, t.attention && d.attention)}>{t.status}</span>
      </span>
    </li>
  );
}

/**
 * The tasks that finished well, folded into one quiet row under the others (DLG-28): a check in the round slot, “4
 * merged” and a chevron; it opens to their rows, drawn as every other row on the same grid.
 */
function Folded({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <li className={d.folded}>
      <button
        type="button"
        className={d.fold}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${label}, ${open ? DELEGATION_WORDS.hideFolded : DELEGATION_WORDS.showFolded}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={cx(d.slot, d.doneSlot)} aria-hidden="true">
          <span className={d.glyph}>
            <Icon icon={Check} size={14} />
          </span>
        </span>
        <span className={d.foldLabel}>
          {label}
          <Icon icon={ChevronDown} size={14} className={cx(c.chevron, open && c.chevronOpen)} />
        </span>
      </button>
      <ul id={id} hidden={!open} className={d.foldedRows}>
        {open && children}
      </ul>
    </li>
  );
}

/**
 * A handed-over task: its number in the round slot (the council's turning ring while it works, a check once done), its
 * title and the AI on it, what it does now, the agent's line, its pull request and its pictures (they open under the
 * row, as the council's final card draws them); where it is and how long it worked at the end, then its ⋯ menu with
 * Open in T3 Code and Stop this task (asked first), when it has either.
 */
function TaskRow({
  task: t,
  attachments,
  menus,
  busy,
  onStop,
}: {
  task: DelegationTaskView;
  attachments: readonly Attachment[];
  /** The list has a menu column: this row fills it, with its menu or empty. */
  menus: boolean;
  /** Its Stop went through and waits for the task to move on. */
  busy: boolean;
  onStop: () => void;
}) {
  const still = useCardStill();
  const id = useId();
  const [pictures, setPictures] = useState(false);
  const shots = t.shots.length > 0;
  const items: ContextMenuItem[] = [];
  const url = t.url;
  if (url)
    items.push({
      label: DELEGATION_WORDS.openThread,
      onSelect: () => window.open(url, '_blank', 'noopener,noreferrer'),
    });
  if (t.stoppable && !busy) items.push({ label: DELEGATION_WORDS.stopTask, onSelect: onStop });
  return (
    <li
      className={cx(d.member, d.task, t.muted && d.muted)}
      data-task={t.id}
      data-working={(t.working && !still) || undefined}
      data-done={t.done || undefined}
      data-attention={t.attention || undefined}
    >
      <span
        className={cx(d.slot, t.working && d.working, t.done && d.doneSlot)}
        role="img"
        aria-label={t.label}
      >
        {t.working && <span className={d.ring} aria-hidden="true" />}
        <span className={d.glyph} aria-hidden="true">
          {t.done ? <Icon icon={Check} size={14} /> : t.slot}
        </span>
      </span>
      <span className={d.who}>
        <span className={d.line}>
          <span className={cx(d.name, d.title)}>{t.title}</span>
          {t.program && <span className={d.provider}>{t.program}</span>}
        </span>
      </span>
      <span className={d.end}>
        <span className={cx(d.status, t.attention && d.attention, t.done && d.done)}>{t.status}</span>
        <span className={d.elapsed}>{still ? null : t.elapsed}</span>
      </span>
      {menus &&
        (items.length > 0 ? (
          <MenuButton label={DELEGATION_WORDS.more(t.title)} items={items} className={cx(d.menu, d.more)}>
            <Icon icon={Ellipsis} size={16} />
          </MenuButton>
        ) : (
          <span className={d.menu} />
        ))}
      {(t.detail || t.note || t.pr || shots || t.items) && (
        <span className={d.body}>
          {t.detail && <span className={cx(d.step, t.items && d.said)}>{t.detail}</span>}
          {t.note && <span className={d.note}>{t.note}</span>}
          {t.items && <Items items={t.items} />}
          {(t.pr || shots) && (
            <span className={d.links}>
              {t.pr && (
                <a className={d.link} href={t.pr} target="_blank" rel="noreferrer noopener">
                  {DELEGATION_WORDS.pullRequest}
                </a>
              )}
              {shots && (
                <button
                  type="button"
                  className={d.link}
                  aria-expanded={pictures}
                  aria-controls={id}
                  onClick={() => setPictures((v) => !v)}
                >
                  {DELEGATION_WORDS.pictures(t.shots.length)}
                </button>
              )}
            </span>
          )}
        </span>
      )}
      {shots && (
        <div id={id} hidden={!pictures} className={d.pictures}>
          {pictures && (
            <ShotPictures shots={t.shots} attachments={attachments} hint={DELEGATION_WORDS.picturesHint} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The items of one thread doing several tasks, under its row: each one's number, ticked once the thread said
 * it finished it, its title and what the thread said about it.
 */
function Items({ items }: { items: readonly DelegationItemView[] }) {
  return (
    <ul className={d.items}>
      {items.map((i) => (
        <li key={i.id} className={d.item} data-done={i.done || undefined} aria-label={i.label}>
          <span className={cx(d.itemMark, i.done && d.done)} aria-hidden="true">
            {i.done ? <Icon icon={Check} size={12} /> : i.n}
          </span>
          <span className={d.itemText}>
            <span className={d.itemTitle}>{i.title}</span>
            {i.note && <span className={d.note}>{i.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* Presses --------------------------------------------------------------------------------------------------------- */

/**
 * Hand over, Stop and Stop this task: the person's presses, a quiet toast when one doesn't go through. One that went
 * through holds its button until the card moves on (its update follows on the socket), so a second press can't be
 * refused.
 */
function useDelegationPress(burrow: string, card: DelegationCardData) {
  const toast = useToast();
  const start = useApiMutation(api.delegations.start);
  const stop = useApiMutation(api.delegations.stop);
  const stopTask = useApiMutation(api.delegations.stopTask);
  const [sentAt, setSentAt] = useState<DelegationCardData['stage'] | null>(null);
  // The tasks whose Stop went through, with their state then: held until the task moves on.
  const [stopped, setStopped] = useState<ReadonlyMap<string, DelegationCardTask['state']>>(new Map());
  const body = { delegationId: card.delegationId };
  const send = async (m: typeof start, fallback: string) => {
    try {
      const r = await m.mutateAsync({ params: { burrow }, body });
      if (r.status === 'ok') setSentAt(card.stage);
      else toast.show(outcomeText(r));
    } catch (err) {
      toast.show(pressFailed(err, fallback));
    }
  };
  return {
    busy: start.isPending || stop.isPending || sentAt === card.stage,
    start: () => send(start, DELEGATION_WORDS.failed.start),
    stop: () => send(stop, DELEGATION_WORDS.failed.stop),
    stoppingTask: (taskId: string) => {
      const was = stopped.get(taskId);
      return was !== undefined && card.tasks.find((t) => t.id === taskId)?.state === was;
    },
    stopTask: async (taskId: string) => {
      const was = card.tasks.find((t) => t.id === taskId)?.state;
      try {
        const r = await stopTask.mutateAsync({ params: { burrow }, body: { ...body, taskId } });
        if (r.status === 'ok' && was) setStopped((held) => new Map(held).set(taskId, was));
        else if (r.status !== 'ok') toast.show(outcomeText(r));
      } catch (err) {
        toast.show(pressFailed(err, DELEGATION_WORDS.failed.stop));
      }
    },
  };
}

/**
 * Why a press didn't go through: a Whombat from before delegations (`unknown_op`) isn't able to yet; a delegation that is
 * gone or was handed over already says so in the server's words.
 */
function pressFailed(err: unknown, fallback: string): string {
  const { code, message } = appErrorOf(err);
  if ((code === 'not_found' || code === 'conflict') && message) return message;
  return refusalText(err, fallback);
}
