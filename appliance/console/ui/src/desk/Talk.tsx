/**
 * Talk to the assistant (mockup 3, DK-06, DK-07) as a conversation (DK-63, DK-64; CG-196…CG-198): the open
 * conversation from Whombat, the person's questions on the right, the assistant's messages on the left with its face,
 * newest at the bottom; scroll or swipe up for the earlier ones. Type, or tap the mic and speak: the mic is voice
 * typing (CG-359…CG-363), its recording bar the composers' (Cancel · the waveform · “Recording 0:12” · Done), and the
 * words wait in the box until *Send*. *Back* keeps the conversation open, *Close conversation* ends it. A server task's
 * card is a live row (TF-17); after a lock the conversation opens where it was read to (TF-18).
 */
import type { FaceState } from '@whombat/avatars/motion';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import { askStateWordsCopy, type Convo, type ConvoRow } from '../lib/conversation';
import type { DeskPaired, DeskPower, DeskSessionTask } from '../lib/desk';
import { deskCopy, deskWordsCopy, fill } from '../lib/deskCopy';
import { liveFaceRow } from '../lib/deskFace';
import { type Dictation, dictationLabel, dictationNotice, MAX_TALK_TEXT } from '../lib/dictation';
import { taskRow } from '../lib/taskCard';
import styles from './desk.module.css';
import { Icon } from './icons';
import { Face, LockChip, ServerCard, TopBar } from './parts';

/** The bars beside the button at rest (the mockup's), and how many show the live level. */
const REST = [10, 22, 36, 18, 44, 30, 52, 26, 40, 16, 30, 12, 24, 8];

/** Bar heights (px) for the last levels, newest on the right; the resting shape while the mic doesn't record. */
export function bars(levels: readonly number[], recording: boolean): number[] {
  if (!recording) return REST;
  const recent = levels.slice(-REST.length);
  const pad = Array.from({ length: REST.length - recent.length }, () => 0);
  return [...pad, ...recent].map((l) => Math.round(6 + Math.min(1, Math.max(0, l)) * 54));
}

/** Within this many px of the end the conversation counts as read to the bottom (it follows new messages). */
const BOTTOM_PX = 48;

/**
 * Where the conversation was read to when it wasn't to the end (TF-18, CG-286): the row at the top and the last row
 * then. Talk opens there again after a lock, saying a new message came when the last row changed.
 */
export interface TalkAnchor {
  top: string;
  /** How far that row's top was below the conversation's (px; negative: partly scrolled past). */
  offset: number;
  last: string | null;
}

export interface TalkProps {
  paired: DeskPaired;
  power: DeskPower | null;
  burrow: string | null;
  convo: Convo;
  /** Whombat's clock (ms): a running task's time ticks with it (TF-17). */
  now: number;
  /** Where it was read to (kept by the desk across a lock, TF-18): opened there once, then kept up to date. */
  anchor?: RefObject<TalkAnchor | null>;
  /** Talk's mic (CG-359): at rest (with a failure on its line for a while), recording, or turning it into text. */
  dictation: Dictation;
  /** The page's clock (ms): the recording's time and how long a failure shows. */
  pageNow: number;
  /** Waiting for the answer, or the assistant working in the conversation (the bars rest quietly). */
  thinking: boolean;
  /** What the assistant's newest face shows (`talkFace`): listening, thinking, working, speaking, sorry or idle. */
  faceState: FaceState;
  levels: readonly number[];
  /** A question in the box (typed, or what the mic heard), or null. */
  draft: string | null;
  canAsk: boolean;
  /** Talk's voice is on and possible: the mic works; without it only typing asks (DK-T12, CG-53). */
  voice: boolean;
  locksIn: number | null;
  /** The camera is on, and it sees someone (DK-28, DK-30): the lock chip says so. */
  camera: boolean;
  present: boolean;
  /** The camera looks for someone in front of the screen (DK-73): its mark on the lock chip. */
  looking?: boolean;
  /** Whether an ask asked in the conversation can be opened (it is still in Needs you). */
  canOpenAsk: (number: number) => boolean;
  onOpenAsk: (number: number) => void;
  onDraft: (text: string | null) => void;
  onSend: (text: string) => void;
  /** The mic tapped, *Done*, *Cancel* (CG-360). */
  onDictate: () => void;
  onDictationDone: () => void;
  onDictationCancel: () => void;
  onBack: () => void;
  /** Ends the open conversation (DK-64); absent: Whombat holds none, no button. */
  onCloseConversation?: () => void;
  onLock: () => void;
  onReplay: (talkId: string) => void;
  /** Fixtures: start at the top of the conversation, with newer messages below. */
  startAtTop?: boolean;
}

export function Talk(p: TalkProps) {
  const t = useT();
  const DESK_WORDS = deskWordsCopy(t);
  const DESK = deskCopy(t);

  const { paired, convo } = p;
  const input = useRef<HTMLTextAreaElement>(null);
  const typing = p.draft !== null;
  const phase = p.dictation.phase;
  const busyMic = phase !== 'idle';
  // The box takes focus when it opens and when the mic's words arrive, the cursor after them (CG-361).
  useEffect(() => {
    const el = input.current;
    if (!typing || busyMic || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [typing, busyMic]);
  const send = () => {
    if (p.draft?.trim() && p.canAsk && !busyMic) p.onSend(p.draft);
  };
  const label = dictationLabel(p.dictation, p.pageNow, t);
  const notice = dictationNotice(p.dictation, p.pageNow, t);
  const dw = DESK_WORDS.dictation;
  // The newest face shows what the assistant does; the earlier ones rest. While it listens it gets the mic's loudness
  // through one function that stays the same (a new one would start its listening again).
  const live = liveFaceRow(convo.rows);
  const heard = useRef(0);
  heard.current = p.levels.at(-1) ?? 0;
  const micLevel = useCallback(() => heard.current, []);
  // The answer plays without a loudness reading, so the mouth follows a talking rhythm of its own while it is said.
  const talkLevel = useCallback(() => {
    const t = performance.now() / 1000;
    return Math.abs(Math.sin(t * 7.1) * Math.sin(t * 2.3 + 1));
  }, []);

  // Follow the newest message while read to the bottom; else say a new one came (DK-63).
  const scroller = useRef<HTMLDivElement>(null);
  const anchor = p.anchor;
  // Opened again after a lock (TF-18): where it was read to, once the conversation is there.
  const restore = useRef(anchor?.current ?? null);
  const atBottom = useRef(!p.startAtTop && restore.current === null);
  const [unseen, setUnseen] = useState(p.startAtTop === true);
  const sig = JSON.stringify(
    convo.rows.map((r) => [r.key, r.paragraphs.length, r.tone, r.ask?.state ?? '', r.task?.state ?? '']),
  );
  const seen = useRef<string | null>(null);
  const lastKey = convo.rows.at(-1)?.key ?? null;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || seen.current === sig) return;
    const first = seen.current === null;
    seen.current = sig;
    const back = restore.current;
    if (back && lastKey !== null) {
      restore.current = null;
      const row = [...el.querySelectorAll<HTMLElement>('[data-key]')].find((r) => r.dataset.key === back.top);
      if (row) {
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - back.offset;
        atBottom.current = false;
        if (back.last !== lastKey) setUnseen(true);
        return;
      }
      atBottom.current = true;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (!first && !back) setUnseen(true);
  }, [sig, lastKey]);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_PX;
    if (atBottom.current) setUnseen(false);
    if (!anchor || restore.current) return;
    // The first row still in sight at the top, and the last one now (TF-18).
    const top = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll<HTMLElement>('[data-key]')];
    const first = rows.find((r) => r.getBoundingClientRect().bottom > top + 1);
    anchor.current =
      atBottom.current || !first?.dataset.key
        ? null
        : {
            top: first.dataset.key,
            offset: first.getBoundingClientRect().top - top,
            last: rows.at(-1)?.dataset.key ?? null,
          };
  }, [anchor]);
  const toNewest = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(false);
  };

  return (
    <div className={styles.voice}>
      <TopBar burrow={p.burrow} power={p.power?.source === 'battery' ? p.power : null}>
        <button type="button" className={`${styles.chip} ${styles.chipButton}`} onClick={p.onBack}>
          <Icon name="back" className={styles.chipIcon} />
          {DESK.back}
        </button>
        {convo.open && p.onCloseConversation && (
          <>
            <span className={styles.sep} />
            <button
              type="button"
              className={`${styles.chip} ${styles.chipButton}`}
              onClick={p.onCloseConversation}
            >
              <Icon name="close" className={styles.chipIcon} />
              {DESK.closeConversation}
            </button>
          </>
        )}
        <span className={styles.sep} />
        <LockChip
          unlocked
          name={paired.person.name}
          minutes={p.locksIn}
          camera={p.camera}
          present={p.present}
          looking={p.looking}
          onLock={p.onLock}
        />
      </TopBar>
      <div className={styles.convoWrap}>
        <div
          className={styles.convo}
          ref={scroller}
          onScroll={onScroll}
          aria-live="polite"
          data-intro={(convo.rows.length === 1 && convo.rows[0]?.key === 'intro') || undefined}
        >
          {convo.earlier > 0 && <p className={styles.convoEarlier}>{DESK.earlierInChat}</p>}
          {convo.rows.map((r, i) => (
            <Row
              key={r.key}
              row={r}
              face={convo.rows[i - 1]?.from !== 'assistant'}
              faceState={i === live ? p.faceState : 'idle'}
              level={
                i !== live
                  ? null
                  : p.faceState === 'listening'
                    ? micLevel
                    : p.faceState === 'speaking'
                      ? talkLevel
                      : null
              }
              pokeable={i === live}
              paired={paired}
              now={p.now}
              canOpenAsk={p.canOpenAsk}
              onOpenAsk={p.onOpenAsk}
              onReplay={p.onReplay}
            />
          ))}
        </div>
        {unseen && (
          <button type="button" className={styles.newPill} onClick={toNewest}>
            <Icon name="down" />
            {DESK.newMessage}
          </button>
        )}
      </div>
      {typing && (
        <form
          className={styles.convoForm}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={input}
            rows={1}
            className={`${styles.draft} ${styles.convoDraft}`}
            value={p.draft ?? ''}
            maxLength={MAX_TALK_TEXT}
            readOnly={busyMic}
            placeholder={fill(DESK_WORDS.typeToAsk, { assistant: paired.assistant.name })}
            aria-label={fill(DESK_WORDS.typeToAsk, { assistant: paired.assistant.name })}
            // One line of words: a line break would be a space anyway (the question is one line).
            onChange={(e) => p.onDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                p.onDraft(null);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="submit"
            className={styles.sendButton}
            disabled={!p.draft?.trim() || !p.canAsk || busyMic}
          >
            {dw.send}
          </button>
        </form>
      )}
      <div className={styles.mic} data-phase={phase}>
        {busyMic ? (
          // The recording bar (CG-360): Cancel · the waveform · what happens · Done.
          <>
            <button type="button" className={styles.micCancel} onClick={p.onDictationCancel}>
              {dw.cancel}
            </button>
            <div className={styles.wave} data-quiet={phase !== 'recording' || undefined} aria-hidden="true">
              {bars(p.levels, phase === 'recording').map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
                <i key={i} style={{ height: h }} />
              ))}
            </div>
            <div className={styles.micLabel} role="status">
              {label}
            </div>
            <button
              type="button"
              className={styles.micDone}
              disabled={phase !== 'recording'}
              onClick={p.onDictationDone}
            >
              {dw.done}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.micButton}
              disabled={!p.voice}
              aria-label={DESK_WORDS.tapToTalk}
              onClick={p.onDictate}
            >
              <Icon name="mic" />
            </button>
            <div className={styles.wave} data-quiet={p.thinking || undefined} aria-hidden="true">
              {bars(p.levels, false).map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
                <i key={i} style={{ height: h }} />
              ))}
            </div>
            {notice ? (
              <div className={styles.hint} role="status" data-tone="bad">
                {notice}
              </div>
            ) : (
              <div className={styles.hint}>
                <b>{DESK_WORDS.tapToTalk}</b>
                <br />
                {DESK_WORDS.wordsFirst}
              </div>
            )}
            <div className={styles.private}>
              <Icon name="lock" />
              {DESK_WORDS.onThisWhombat}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One message: the person's on the right, the assistant's on the left with its face (once per run of them). */
function Row({
  row,
  face,
  faceState,
  level,
  pokeable,
  paired,
  now,
  canOpenAsk,
  onOpenAsk,
  onReplay,
}: {
  row: ConvoRow;
  face: boolean;
  faceState: FaceState;
  level: (() => number) | null;
  pokeable: boolean;
  paired: DeskPaired;
  now: number;
  canOpenAsk: (number: number) => boolean;
  onOpenAsk: (number: number) => void;
  onReplay: (talkId: string) => void;
}) {
  const t = useT();
  const DESK = deskCopy(t);
  const ASK_STATE_WORDS = askStateWordsCopy(t);

  const words = row.paragraphs.map((t, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a message's paragraphs in their order
    <span key={i} className={styles.msgPara}>
      {t}
    </span>
  ));
  if (row.from === 'you') {
    return (
      <div className={styles.msg} data-from="you" data-tone={row.tone} data-key={row.key}>
        <article className={styles.bubble} aria-label={DESK.you}>
          {row.paragraphs.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's paragraphs in their order
            <p key={i}>{t}</p>
          ))}
        </article>
      </div>
    );
  }
  const replay = row.replay;
  const ask = row.ask;
  return (
    <div className={styles.msg} data-from="assistant" data-tone={row.tone} data-key={row.key}>
      {face ? (
        <Face
          face={paired.assistant.face}
          size={44}
          label={paired.assistant.name}
          state={faceState}
          level={level}
          pokeable={pokeable}
        />
      ) : (
        <span className={styles.msgIndent} aria-hidden="true" />
      )}
      <div className={styles.msgBody}>
        {row.task ? (
          <TaskRow task={row.task} now={now} />
        ) : replay ? (
          <button
            type="button"
            className={`${styles.plain} ${styles.msgText}`}
            onClick={() => onReplay(replay)}
            aria-label={`${row.paragraphs.join(' ')} ${DESK.playAgain}`}
          >
            {words}
          </button>
        ) : (
          <p className={styles.msgText}>{words}</p>
        )}
        {row.more && <p className={styles.msgMore}>{DESK.moreInChat}</p>}
        {ask && (
          <div className={styles.inAsk} data-state={ask.state}>
            <span className={styles.inAskState}>
              <i className={styles.inAskDot} />
              {ASK_STATE_WORDS[ask.state]}
            </span>
            {ask.state === 'waiting' && canOpenAsk(ask.number) && (
              <button type="button" className={styles.inAskOpen} onClick={() => onOpenAsk(ask.number)}>
                {DESK.answer}
              </button>
            )}
          </div>
        )}
        {row.thing && <ServerCard server={row.thing} className={styles.thing} />}
      </div>
    </div>
  );
}

/**
 * A server task's card as a live row (TF-17, CG-284): a dot in the state's tone, the title, the state's label and the
 * time it has run (ticking) or took, and once it ended the outcome's line.
 */
function TaskRow({ task, now }: { task: DeskSessionTask; now: number }) {
  const t = useT();

  const v = taskRow(task, now, t);
  return (
    <article className={styles.task} data-state={task.state} aria-label={`${v.title}. ${v.label}`}>
      <i className={styles.taskDot} aria-hidden="true" />
      <div className={styles.taskMain}>
        <p className={styles.taskTitle}>{v.title}</p>
        <p className={styles.taskMeta}>
          {v.label}
          {v.time && <span className={styles.taskTime}> · {v.time}</span>}
        </p>
        {v.result && <p className={styles.taskResult}>{v.result}</p>}
      </div>
    </article>
  );
}
