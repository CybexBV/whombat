import { elderSvg } from '@whombat/avatars';
import { BrandMark } from '@whombat/brand/react';
import {
  CARD_FRAME_WORDS,
  COUNCIL_WORDS,
  type CouncilCardView,
  type CouncilMemberView,
  councilCardView,
  councilFrame,
  councilStepIndex,
  councilSteps,
} from '@whombat/client';
import { useApiMutation } from '@whombat/client/react';
import { appErrorOf } from '@whombat/client/signins';
import type {
  Attachment,
  CouncilCard as CouncilCardData,
  CouncilKind,
  CouncilMark,
  CouncilStage,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { Check, Ellipsis } from 'lucide-react';
import { type CSSProperties, useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { outcomeText, refusalText } from '../conversations/refusal';
import { RichText } from '../messaging/RichText';
import { useTicker } from '../messaging/useRoom';
import { MenuButton } from '../things/manage/MenuButton';
import { CardFrame, cardMenuLabel, DetailsHeading, FootButton, FrameButton, frameStyles } from './CardFrame';
import c from './CouncilCard.module.css';
import { useCardStill } from './cardLook';
import { CardLink } from './parts';
import { ShotPictures } from './ShotPictures';

export interface CouncilCardProps {
  burrow: string;
  card: CouncilCardData;
  /** The message's files: the card shows its pictures of what changed from them (the message's own strip leaves them out). */
  attachments?: readonly Attachment[];
  /** Opens an app path in place (the live card's way to Settings → the assistant → Council). */
  onNavigate?: (href: string) => void;
}

/** Settings → the assistant → Council: who sits on the next council. */
export const COUNCIL_SETTINGS_HREF = '/settings?tab=agent&part=council';

/**
 * A council the agent leads (Whombat council.md CNL-40…CNL-44, CNL-60…CNL-64), in the cards' one layout
 * (docs/decisions/chat-threads-cards.md). While it works: Working (or Waiting for you at a go-ahead), its title, where it
 * is in one sentence and Stop (it asks first); its members open in place, each with its provider's mark (a turning ring
 * while it works), its state, how long it took and its answer to open; the earlier rounds, the plan and the way to change
 * who sits on the next council are under Details. The final card: Done or Stopped, how it came out in words (“All three
 * agree.”) and Read the answers, which opens Details with each member's answer, the plan, every round's scores and the
 * pictures of what changed. Every word comes from `councilFrame`, `councilCardView` and `COUNCIL_WORDS`, which the phone
 * shares.
 */
export function CouncilCard({ burrow, card, attachments, onNavigate }: CouncilCardProps) {
  // A copy of the card as it was (card-moves.md) keeps still: its clocks would count on from long ago.
  const still = useCardStill();
  const working = card.live && card.members.some((m) => m.state === 'working');
  const now = useTicker(working && !still);
  const view = councilCardView(card, now);
  const frame = councilFrame(card);
  const press = useCouncilPress(burrow, card.councilId, card.stage);
  const [asking, setAsking] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const answered = view.members.filter((m) => m.answer);
  const data = { 'data-variant': card.live ? 'live' : 'final', 'data-stage': card.stage };
  // Stop steps back: a quiet word at the card's foot and in its ⋯ menu, never a big
  // button above the work; it still asks first.
  const stop = view.stoppable ? (
    <FootButton disabled={press.busy} onClick={() => setAsking(true)} data-council-stop="">
      {COUNCIL_WORDS.stop}
    </FootButton>
  ) : null;
  const go = onNavigate ?? ((href: string) => window.location.assign(href));
  const menu = card.live ? (
    <MenuButton
      label={cardMenuLabel(card.title)}
      className={frameStyles.menuButton}
      items={[
        { label: COUNCIL_WORDS.changeCouncil, onSelect: () => go(COUNCIL_SETTINGS_HREF) },
        ...(view.stoppable
          ? [{ label: `${COUNCIL_WORDS.stop}…`, onSelect: () => setAsking(true), separated: true }]
          : []),
      ]}
    >
      <Icon icon={Ellipsis} size={16} />
    </MenuButton>
  ) : null;
  return (
    <CardFrame
      card="council"
      frame={frame}
      className={c.card}
      data={data}
      menu={menu}
      foot={stop}
      track={card.live ? <CouncilTrack kind={card.what} stage={card.stage} /> : undefined}
      // Who sits on it and how each one is doing, as elders at one table: open on the card, on a phone too, and
      // still there, without moving, once it finished.
      content={
        view.members.length > 0 ? <CouncilRoom members={view.members} reading={card.live} /> : undefined
      }
      actions={
        card.live ? null : answered.length > 0 ? (
          <FrameButton main aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
            {detailsOpen ? CARD_FRAME_WORDS.hideAnswers : CARD_FRAME_WORDS.readAnswers}
          </FrameButton>
        ) : null
      }
      detailsOpen={detailsOpen}
      // A finished card with answers: “Read the answers” opens what Details would, so it is the one way in.
      detailsToggle={card.live || answered.length === 0}
      onDetailsToggle={setDetailsOpen}
      details={
        card.live ? (
          <LiveDetails card={card} view={view} onNavigate={onNavigate} />
        ) : (
          <FinalDetails card={card} view={view} answered={answered} attachments={attachments ?? []} />
        )
      }
      after={
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          kicker={COUNCIL_WORDS.name}
          title={COUNCIL_WORDS.stopAsk.title}
          confirmLabel={COUNCIL_WORDS.stop}
          cancelLabel={COUNCIL_WORDS.stopAsk.keep}
          busy={press.busy}
          onConfirm={() => {
            setAsking(false);
            void press.stop();
          }}
        >
          {COUNCIL_WORDS.stopAsk.body}
        </ConfirmDialog>
      }
    />
  );
}

/**
 * The council's steps under its title, by what it does (Look · Plan · Go-ahead · Build · Check; Research · Agree; none
 * for a review): the ones done ticked, the current one marked and named for a screen reader.
 */
function CouncilTrack({ kind, stage }: { kind: CouncilKind; stage: CouncilStage }) {
  const steps = councilSteps(kind);
  const at = councilStepIndex(stage, kind);
  if (!steps.length) return null;
  return (
    <ol className={c.track} aria-label={`${COUNCIL_WORDS.name} steps`} data-council-track="">
      {steps.map((step, i) => {
        const state = i < at ? 'done' : i === at ? 'now' : 'next';
        return (
          <li
            key={step}
            className={c.trackStep}
            data-state={state}
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <span className={c.trackDot} aria-hidden="true">
              {state === 'done' && <Icon icon={Check} size={9} />}
            </span>
            <span className={c.trackWord}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* The live card's Details ----------------------------------------------------------------------------------------- */

/** The earlier rounds in a line each, the plan once agreed, and the quiet way to change who sits on the next council. */
function LiveDetails({
  card,
  view,
  onNavigate,
}: {
  card: CouncilCardData;
  view: CouncilCardView;
  onNavigate: ((href: string) => void) | undefined;
}) {
  return (
    <>
      {view.progress && <p className={c.stage}>{view.progress}</p>}
      {view.earlier.length > 0 && (
        <ul className={c.earlier}>
          {view.earlier.map((line, i) => (
            // Rounds keep their order; two may read alike.
            // biome-ignore lint/suspicious/noArrayIndexKey: a round's line has no id
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {card.plan && (
        <>
          <DetailsHeading>{COUNCIL_WORDS.plan}</DetailsHeading>
          <RichText text={card.plan} className={c.rich} />
        </>
      )}
      <CardLink className={c.changeCouncil} href={COUNCIL_SETTINGS_HREF} onNavigate={onNavigate}>
        {COUNCIL_WORDS.changeCouncil}
      </CardLink>
    </>
  );
}

/**
 * The council's room: each member an elder at one table (`@whombat/avatars` `elderSvg`), in seat order, and in front of
 * each its plaque: its model's name (a link to its thread in T3 Code), its company's mark and name, the builder's tag and
 * step on a council from before its plans became delegations, and how it is doing (Working and how long, its score and
 * verdict, or its state). The drawings are decorative; the plaques say it all, as a list. While the council works,
 * “Read its answer” on a plaque opens that answer under the table (one at a time), with a link to T3 Code when the card
 * holds only its start; a finished card reads them under Details. The elders move only while they think, and never on
 * a card's copy or with reduced motion.
 */
function CouncilRoom({ members, reading }: { members: readonly CouncilMemberView[]; reading: boolean }) {
  const still = useCardStill();
  const id = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = reading && !still ? members.find((m) => m.id === openId && m.answer) : undefined;
  const answerId = `${id}-answer`;
  return (
    <div className={c.council} data-council-room="" data-still={still || undefined}>
      <div className={c.room} style={{ '--seats': members.length } as CSSProperties}>
        <div className={c.elders} aria-hidden="true">
          {members.map((m, i) => (
            <span
              key={m.id}
              className={c.elder}
              data-pose={m.pose}
              // Whombat's own drawing from its seat and pose: no words of anyone's go into it.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: a static SVG built from a number and an enum
              dangerouslySetInnerHTML={{
                __html: elderSvg({ seat: i, pose: m.pose, idPrefix: `elder${id}-${i}` }),
              }}
            />
          ))}
        </div>
        <ul className={c.bench}>
          {members.map((m) => (
            <Plaque
              key={m.id}
              member={m}
              still={still}
              reading={reading && !still}
              open={open?.id === m.id}
              answerId={answerId}
              onRead={() => setOpenId((was) => (was === m.id ? null : m.id))}
            />
          ))}
        </ul>
      </div>
      {open?.answer && (
        <div id={answerId} className={c.answer} data-member-answer={open.id}>
          <p className={c.answerOf}>{open.name}</p>
          <RichText text={open.answer} className={c.rich} />
          {open.cut && open.url && (
            <a className={c.rest} href={open.url} target="_blank" rel="noreferrer noopener">
              {COUNCIL_WORDS.restInT3}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Plaque({
  member: m,
  still,
  reading,
  open,
  answerId,
  onRead,
}: {
  member: CouncilMemberView;
  still: boolean;
  reading: boolean;
  open: boolean;
  answerId: string;
  onRead: () => void;
}) {
  return (
    <li
      className={cx(c.plaque, m.muted && c.quiet)}
      data-member={m.id}
      data-pose={m.pose}
      data-working={(m.working && !still) || undefined}
    >
      {m.url ? (
        <a className={cx(c.name, c.nameLink)} href={m.url} target="_blank" rel="noreferrer noopener">
          {m.name}
        </a>
      ) : (
        <span className={c.name}>{m.name}</span>
      )}
      <span className={c.company}>
        <span className={c.companyMark} aria-hidden="true">
          {m.mark ? <BrandMark mark={m.mark} size={12} /> : m.letter}
        </span>
        {m.provider}
        {m.builder && <span className={c.tag}>{COUNCIL_WORDS.builder}</span>}
      </span>
      {m.step && <span className={c.step}>{m.step}</span>}
      {m.score || m.verdict ? (
        <span className={c.result}>
          {m.score && <span className={c.score}>{m.score}</span>}
          {m.verdict && (
            <span className={m.verdict === COUNCIL_WORDS.verdicts.agree ? c.agree : c.changes}>
              {m.verdict}
            </span>
          )}
        </span>
      ) : (
        <span className={c.status}>
          <span>{m.status}</span>
          {m.working && m.elapsed && !still && (
            <span className={c.elapsed}>
              <span className={c.dot} aria-hidden="true">
                ·
              </span>
              {m.elapsed}
            </span>
          )}
        </span>
      )}
      {reading && m.answer && (
        <button
          type="button"
          className={c.read}
          aria-expanded={open}
          aria-controls={open ? answerId : undefined}
          onClick={onRead}
        >
          {open ? COUNCIL_WORDS.hideAnswer : COUNCIL_WORDS.readAnswer}
        </button>
      )}
    </li>
  );
}

/** A member's provider mark in its 24px round slot: Claude's and OpenAI's own, any other provider its first letter. */
function Mark({ mark, letter }: { mark: CouncilMark | null; letter: string }) {
  return (
    <span className={c.slot} aria-hidden="true">
      <span className={c.glyph}>{mark ? <BrandMark mark={mark} size={14} /> : letter}</span>
    </span>
  );
}

/**
 * Stop: the person's press, a quiet toast when it doesn't go through. One that went through holds the button until the
 * card moves on (its update follows on the socket), so a second press can't be refused.
 */
function useCouncilPress(burrow: string, councilId: string, stage: CouncilCardData['stage']) {
  const toast = useToast();
  const stop = useApiMutation(api.councils.stop);
  const [sentAt, setSentAt] = useState<CouncilCardData['stage'] | null>(null);
  return {
    busy: stop.isPending || sentAt === stage,
    stop: async () => {
      try {
        const r = await stop.mutateAsync({ params: { burrow }, body: { councilId } });
        if (r.status === 'ok') setSentAt(stage);
        else toast.show(outcomeText(r));
      } catch (err) {
        toast.show(pressFailed(err, COUNCIL_WORDS.failed.stop));
      }
    },
  };
}

/**
 * Why a press didn't go through: a Whombat from before councils (`unknown_op`) isn't able to yet; a council that is gone
 * or no longer waits says so in the server's words.
 */
function pressFailed(err: unknown, fallback: string): string {
  // The session's `unknown_op` isn't one of the HTTP error codes: it is read from the answer's body.
  const { code, message } = appErrorOf(err);
  if ((code === 'not_found' || code === 'conflict') && message) return message;
  return refusalText(err, fallback);
}

/* The final card's Details ---------------------------------------------------------------------------------------- */

/**
 * What the final card keeps under Details: each member's last answer in full (with its verdict in words), the plan, every
 * round's scores and the pictures of what changed with their numbered notes.
 */
function FinalDetails({
  card,
  view,
  answered,
  attachments,
}: {
  card: CouncilCardData;
  view: CouncilCardView;
  answered: readonly CouncilMemberView[];
  attachments: readonly Attachment[];
}) {
  const { columns, rows } = view.table;
  const last = columns.length - 1;
  return (
    <>
      {answered.length > 0 && (
        <>
          <DetailsHeading>{CARD_FRAME_WORDS.answers}</DetailsHeading>
          <ul className={c.answerList}>
            {answered.map((m) => (
              <li key={m.id} className={c.answerItem} data-member={m.id}>
                <span className={c.answerWho}>
                  <Mark mark={m.mark} letter={m.letter} />
                  {m.url ? (
                    <a
                      className={cx(c.name, c.nameLink)}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {m.name}
                    </a>
                  ) : (
                    <span className={c.name}>{m.name}</span>
                  )}
                </span>
                <span className={c.answerVerdict}>{m.verdict ?? m.status}</span>
                {m.answer && <RichText text={m.answer} className={c.rich} />}
                {m.cut && m.url && (
                  <a className={c.rest} href={m.url} target="_blank" rel="noreferrer noopener">
                    {COUNCIL_WORDS.restInT3}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {card.plan && (
        <>
          <DetailsHeading>{COUNCIL_WORDS.plan}</DetailsHeading>
          <RichText text={card.plan} className={c.rich} />
        </>
      )}
      {columns.length > 0 && rows.length > 0 && (
        <div className={c.tableBox}>
          <table className={c.table}>
            <thead>
              <tr>
                <td />
                {columns.map((col, i) => (
                  <th key={col} scope="col" className={cx(i === last && c.last)}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <th scope="row">
                    <span className={c.rowName}>
                      <Mark mark={r.mark} letter={r.letter} />
                      <span className={c.name}>{r.name}</span>
                    </span>
                  </th>
                  {r.cells.map((cell, i) => (
                    // A round's cells are in the columns' order.
                    // biome-ignore lint/suspicious/noArrayIndexKey: the column is the cell's place
                    <td key={i} className={cx(i === last && c.last)}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {card.shots.length > 0 && (
        <div className={c.pictures}>
          <DetailsHeading>{COUNCIL_WORDS.pictures}</DetailsHeading>
          <ShotPictures shots={card.shots} attachments={attachments} hint={COUNCIL_WORDS.picturesHint} />
        </div>
      )}
    </>
  );
}
