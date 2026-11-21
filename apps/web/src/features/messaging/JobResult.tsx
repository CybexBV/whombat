/**
 * A job's result (job-result mockup, scene C): T3 Code's own report as a message in the thread it was handed over from,
 * laid out from its parts (`jobResultView`, `@whombat/client`) with everything open except the technical detail — the
 * outcome, what changed by area, what T3 Code decided, what its council decided, what is left for the person with its
 * choices, then one line of facts. The person marks a choice or writes words on the points left for them and sends them
 * together; while T3 Code works on them the points say what was chosen. Every word is `JOB_RESULT_WORDS`; a part the
 * report wrote in its own shape is drawn from its markdown, never dropped.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  handoffMinutes,
  JOB_RESULT_WORDS,
  type JobPointMark,
  type JobReportSection,
  type JobResultFact,
  type JobResultPoint,
  type JobResultView,
  jobAnswersOf,
  jobResultView,
  jobSendBar,
} from '@whombat/client';
import { upsertMessageEverywhere } from '@whombat/client/query';
import { useJobAnswers } from '@whombat/client/react';
import { formatClock, type Message } from '@whombat/core';
import { AlertCircle, Check, ChevronRight, Circle } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { outcomeText, refusalText } from '../conversations/refusal';
import { CouncilFaces } from './CouncilFaces';
import styles from './JobResult.module.css';
import { RichText } from './RichText';
import { useTicker } from './useRoom';

const W = JOB_RESULT_WORDS;

type Marks = Readonly<Record<number, JobPointMark | undefined>>;
const NO_MARKS: Marks = {};

/**
 * What the person marked, per result message, outside the row: the thread can draw the row again, or close and open,
 * and the marks stay until they are sent. A report whose points changed (T3 Code wrote it again) starts without them.
 */
const kept = new Map<string, { sig: string; marks: Marks }>();

function useMarks(messageId: string, sig: string) {
  const [state, setState] = useState(() => {
    const k = kept.get(messageId);
    return k && k.sig === sig ? k : { sig, marks: NO_MARKS };
  });
  const marks = state.sig === sig ? state.marks : NO_MARKS;
  const update = (fn: (marks: Marks) => Marks) =>
    setState((s) => {
      const next = { sig, marks: fn(s.sig === sig ? s.marks : NO_MARKS) };
      kept.set(messageId, next);
      return next;
    });
  return [marks, update] as const;
}

/** “You chose …” around the choice, so the choice itself can stand out. */
const CHOSE = W.left.chose('\u0000').split('\u0000') as [string, string];

/** `**Deploy scripts:** removed …` reads as a sentence of its own once the label stands in its column. */
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const marked = (m: JobPointMark | undefined): boolean => !!(m?.choice?.trim() || m?.words?.trim());

/** A short piece of the report's markdown (a point's title, a reason), as one quiet paragraph. */
function Md({ text, className }: { text: string; className?: string }) {
  return <RichText text={text} className={cx(styles.md, className)} />;
}

/** The report as T3 Code laid it out, under T3 Code's name in the thread. Null for any other message. */
export function JobResultBody({
  burrow,
  message,
  timeZone,
}: {
  burrow: string;
  message: Pick<Message, 'id' | 'text' | 'jobResult' | 'deletedAt'>;
  timeZone: string;
}) {
  const view = useMemo(
    () => jobResultView({ text: message.text, jobResult: message.jobResult, deletedAt: message.deletedAt }),
    [message.text, message.jobResult, message.deletedAt],
  );
  if (!view) return null;
  return <Report burrow={burrow} messageId={message.id} view={view} timeZone={timeZone} />;
}

function Report({
  burrow,
  messageId,
  view,
  timeZone,
}: {
  burrow: string;
  messageId: string;
  view: JobResultView;
  timeZone: string;
}) {
  const { report } = view;
  const sig = report.points.map((p) => `${p.n}\u0000${p.title}\u0000${p.choices.join('|')}`).join('\n');
  const [marks, setMarks] = useMarks(messageId, sig);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailId = useId();
  const send = useJobAnswers(burrow);
  const qc = useQueryClient();
  const toast = useToast();
  // The send bar goes under the last part with points to answer.
  let lastLeft = -1;
  report.sections.forEach((s, i) => {
    if (s.kind === 'left' && s.points.length > 0) lastLeft = i;
  });
  const count = view.points.filter((p) => !p.answer && marked(marks[p.n])).length;

  const mark = (n: number, next: JobPointMark | null) =>
    setMarks((m) => {
      const out = { ...m };
      if (next) out[n] = next;
      else delete out[n];
      return out;
    });

  const sendAll = async () => {
    const answers = jobAnswersOf(view.points, marks);
    if (!answers.length || send.isPending) return;
    try {
      const r = await send.mutateAsync({ messageId, answers });
      if (r.status !== 'ok') return toast.show(outcomeText(r));
      // The thread shows the message as the server answered it; the `message.updated` frame says the same.
      upsertMessageEverywhere(qc, r.data.message);
      setMarks(() => NO_MARKS);
    } catch (err) {
      toast.show(refusalText(err, W.left.failed));
    }
  };

  return (
    <div className={styles.result} data-job-result="">
      {report.outcome && <RichText text={report.outcome} className={styles.outcome} />}
      {report.sections.map((s, i) => (
        <Section
          // biome-ignore lint/suspicious/noArrayIndexKey: a report's sections never reorder
          key={i}
          section={s}
          view={view}
          timeZone={timeZone}
          marks={marks}
          onMark={mark}
          bar={
            i === lastLeft ? (
              <SendBar
                view={view}
                count={count}
                sending={send.isPending}
                onSend={() => void sendAll()}
                timeZone={timeZone}
              />
            ) : null
          }
        />
      ))}
      {view.cut && (
        <p className={styles.cut}>
          {view.url ? (
            <a href={view.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
              {W.facts.rest}
            </a>
          ) : (
            W.facts.rest
          )}
        </p>
      )}
      <Facts
        facts={view.facts}
        url={view.url}
        detail={report.detail}
        detailOpen={detailOpen}
        detailId={detailId}
        onDetail={() => setDetailOpen((o) => !o)}
      />
      {report.detail && detailOpen && (
        <div id={detailId} className={styles.detail} data-job-detail="">
          <RichText text={report.detail} className={styles.prose} />
        </div>
      )}
    </div>
  );
}

/* Sections ---------------------------------------------------------------------------------------------------------- */

function Section({
  section: s,
  view,
  timeZone,
  marks,
  onMark,
  bar,
}: {
  section: JobReportSection;
  view: JobResultView;
  timeZone: string;
  marks: Marks;
  onMark: (n: number, next: JobPointMark | null) => void;
  bar: ReactNode;
}) {
  const intro = s.intro ? <Md text={s.intro} className={styles.intro} /> : null;
  const outro = s.outro ? <Md text={s.outro} className={styles.outro} /> : null;
  const body = <RichText text={s.body} className={styles.prose} />;
  switch (s.kind) {
    case 'changed':
      return (
        <section className={styles.section} data-part="changed">
          <h3 className={styles.heading}>{s.title}</h3>
          {s.groups ? (
            <>
              {intro}
              {s.groups.some((g) => g.label) ? (
                <div className={styles.groups}>
                  {s.groups.map((g, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the report's order
                    <div key={i} className={styles.group}>
                      <div className={styles.label}>{g.label}</div>
                      <Bullets items={g.label ? g.items.map(upperFirst) : g.items} />
                    </div>
                  ))}
                </div>
              ) : (
                <Bullets items={s.groups.flatMap((g) => g.items)} />
              )}
              {outro}
            </>
          ) : (
            body
          )}
        </section>
      );
    case 'council':
      return (
        <section className={styles.section} data-part="council">
          <h3 className={styles.heading}>
            <CouncilFaces />
            {s.title}
          </h3>
          {s.decisions ? (
            <>
              {intro}
              <ul className={styles.decisions}>
                {s.decisions.map((d, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the report's order
                  <li key={i} className={styles.decision}>
                    <span className={styles.status} data-tone={d.tone}>
                      <Icon icon={d.tone === 'ok' ? Check : Circle} size={14} />
                      {d.status}
                    </span>
                    <span>
                      <Md text={d.title} className={styles.question} />
                      {d.reason && <Md text={d.reason} className={styles.answer} />}
                    </span>
                  </li>
                ))}
              </ul>
              {outro}
            </>
          ) : (
            body
          )}
        </section>
      );
    case 'left': {
      const open = s.points.filter((p) => !view.points.find((v) => v.n === p.n)?.answer).length;
      const answerable = !view.pending && open > 0;
      return (
        <section className={styles.section} data-part="left">
          <h3 className={styles.heading}>
            <span className={styles.amber} aria-hidden="true" />
            {s.title}
            {s.points.length > 0 && view.open > 0 && <span className={styles.count}>{view.open}</span>}
          </h3>
          {s.points.length ? (
            <>
              {(intro || answerable) && (
                <div className={styles.intros}>
                  {intro}
                  {answerable && <p className={styles.intro}>{W.left.intro}</p>}
                </div>
              )}
              <ol className={styles.points}>
                {s.points.map((p) => {
                  const point = view.points.find((v) => v.n === p.n) ?? { ...p, answer: null };
                  return (
                    <Point
                      key={p.n}
                      point={point}
                      mark={marks[p.n]}
                      onMark={(next) => onMark(p.n, next)}
                      locked={!!view.pending}
                      sentAt={view.pending ? formatClock(view.pending.at, timeZone) : null}
                    />
                  );
                })}
              </ol>
              {outro}
              {bar}
            </>
          ) : (
            body
          )}
        </section>
      );
    }
    default:
      return (
        <section className={styles.section} data-part={s.kind}>
          <h3 className={styles.heading}>{s.title}</h3>
          {body}
        </section>
      );
  }
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className={styles.bullets}>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the report's order
        <li key={i}>
          <Md text={item} />
        </li>
      ))}
    </ul>
  );
}

/* A point left for the person ---------------------------------------------------------------------------------------- */

function Point({
  point: p,
  mark,
  onMark,
  locked,
  sentAt,
}: {
  point: JobResultPoint;
  mark: JobPointMark | undefined;
  onMark: (next: JobPointMark | null) => void;
  /** Answers are with T3 Code now: nothing more can be marked until it is done. */
  locked: boolean;
  sentAt: string | null;
}) {
  const titleId = useId();
  const [writing, setWriting] = useState(false);
  const words = mark?.words ?? '';
  const boxOpen = writing || !!words;
  if (p.answer)
    return (
      <li className={styles.point} data-answered="">
        <h4 className={styles.pointTitle}>
          <RichText text={p.title} className={styles.md} />
        </h4>
        {p.text && <Md text={p.text} className={styles.answer} />}
        <div className={styles.answered}>
          <span className={styles.you}>
            {p.answer.choice ? (
              <>
                {CHOSE[0]}
                <b>{p.answer.choice}</b>
                {CHOSE[1]}
              </>
            ) : (
              W.left.wrote
            )}
            {sentAt && <span className={styles.sentAt}> · {sentAt}</span>}
          </span>
          {p.answer.words && <span className={styles.words}>“{p.answer.words}”</span>}
        </div>
      </li>
    );
  return (
    <li className={styles.point}>
      <h4 className={styles.pointTitle} id={titleId}>
        <RichText text={p.title} className={styles.md} />
      </h4>
      {p.text && <Md text={p.text} className={styles.answer} />}
      {p.advice && (
        <div className={styles.advice}>
          {p.council && <CouncilFaces />}
          <Md text={`**${p.council ? W.council : W.advice}** ${p.advice}`} />
        </div>
      )}
      <fieldset className={styles.choices} aria-labelledby={titleId}>
        {p.choices.map((c) => {
          const on = mark?.choice === c;
          return (
            <button
              key={c}
              type="button"
              className={styles.choice}
              aria-pressed={on}
              disabled={locked}
              onClick={() => {
                // A choice is marked, not sent; pressing it again takes it back. Words and a choice are one or the other.
                setWriting(false);
                onMark(on ? null : { choice: c, words: null });
              }}
            >
              {on && <Icon icon={Check} size={14} />}
              {c}
            </button>
          );
        })}
        <button
          type="button"
          className={styles.reply}
          aria-expanded={boxOpen}
          disabled={locked}
          onClick={() => {
            setWriting(true);
            if (mark?.choice) onMark(words ? { choice: null, words } : null);
          }}
        >
          {W.left.reply}
        </button>
      </fieldset>
      {boxOpen && !locked && (
        <textarea
          className={styles.box}
          rows={2}
          aria-label={W.left.replyLabel(p.title)}
          placeholder={W.left.replyPlaceholder}
          value={words}
          // biome-ignore lint/a11y/noAutofocus: the person just asked for the box
          autoFocus={writing}
          onChange={(e) => onMark(e.target.value ? { choice: null, words: e.target.value } : null)}
        />
      )}
    </li>
  );
}

/* Sending ------------------------------------------------------------------------------------------------------------ */

function SendBar({
  view,
  count,
  sending,
  onSend,
  timeZone,
}: {
  view: JobResultView;
  count: number;
  sending: boolean;
  onSend: () => void;
  timeZone: string;
}) {
  const now = useTicker(!!view.pending, 30_000);
  const bar = jobSendBar(view, count);
  const done = !view.pending && view.done ? view.done : null;
  if (!bar && !view.pending && !done) return null;
  return (
    <div className={styles.sendbar} data-send-bar="">
      {view.pending ? (
        <>
          <span className={styles.state} role="status">
            <span className={styles.dot} aria-hidden="true" />
            {W.left.sent(view.pending.answers, handoffMinutes(Date.parse(view.pending.at), now))}
          </span>
          {view.open > 0 && (
            <span className={cx(styles.hint, styles.full)}>{W.left.hintOpen(view.open)}</span>
          )}
        </>
      ) : null}
      {done && (
        <span className={cx(styles.state, bar && styles.full)} data-tone={done.outcome} role="status">
          {done.outcome === 'completed' ? (
            <>
              <Icon icon={Check} size={14} />
              {W.left.done(formatClock(done.at, timeZone))}
            </>
          ) : done.outcome === 'failed' ? (
            <>
              <Icon icon={AlertCircle} size={14} />
              {W.left.problem}
            </>
          ) : (
            W.left.stopped
          )}
        </span>
      )}
      {bar && (
        <>
          <button type="button" className={styles.send} disabled={!bar.enabled || sending} onClick={onSend}>
            {bar.button}
          </button>
          <span className={styles.hint} role="status">
            {bar.hint}
          </span>
        </>
      )}
    </div>
  );
}

/* The facts line ----------------------------------------------------------------------------------------------------- */

function Facts({
  facts,
  url,
  detail,
  detailOpen,
  detailId,
  onDetail,
}: {
  facts: readonly JobResultFact[];
  url: string | null;
  detail: string | null;
  detailOpen: boolean;
  detailId: string;
  onDetail: () => void;
}) {
  if (!facts.length && !detail && !url) return null;
  return (
    <div className={styles.facts} data-job-facts="">
      {facts.length > 0 && (
        <span className={styles.factGroup}>
          {facts.map((f) => (
            <span key={f.key} className={styles.fact} data-tone={f.tone ?? undefined}>
              {f.tone === 'ok' && <Icon icon={Check} size={13} />}
              {f.tone === 'bad' && <Icon icon={AlertCircle} size={13} />}
              {f.url ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer" className={styles.factLink}>
                  {f.text}
                </a>
              ) : (
                f.text
              )}
            </span>
          ))}
        </span>
      )}
      {(detail || url) && (
        <span className={styles.factGroup}>
          {detail && (
            <span className={styles.fact}>
              <button
                type="button"
                className={styles.detailToggle}
                aria-expanded={detailOpen}
                aria-controls={detailId}
                onClick={onDetail}
              >
                {W.facts.detail}
                <Icon icon={ChevronRight} size={13} className={styles.chevron} />
              </button>
            </span>
          )}
          {url && (
            <span className={styles.fact}>
              <a href={url} target="_blank" rel="noopener noreferrer" className={styles.factLink}>
                {W.facts.open}
              </a>
            </span>
          )}
        </span>
      )}
    </div>
  );
}
