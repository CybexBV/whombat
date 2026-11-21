/**
 * A job handed to T3 Code, in the thread it was handed over from: at the thread's end T3 Code's plan, its pull request,
 * what it changed, its checks, the question it waits on with its answers, a box to steer it, and the receipt once it
 * ended, with T3 Code's whole answer to open under it. A permission it waits for is said once, on T3 Code's line above
 * (approved in T3 Code only). Every word and row is `@whombat/client`'s `job.ts`; a part the box didn't give is not
 * drawn.
 */
import {
  JOB_WORDS,
  type JobQuestion,
  jobAnswer,
  jobCanMessage,
  jobChanges,
  jobChecks,
  jobPlan,
  jobPullRequest,
  jobQuestion,
  jobReceipt,
} from '@whombat/client';
import { useJobActions } from '@whombat/client/react';
import type { Handoff } from '@whombat/core';
import { Check, GitPullRequest, MessageSquare, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { outcomeText, refusalText } from '../conversations/refusal';
import styles from './JobView.module.css';
import { RichText } from './RichText';

/** The job's parts at the thread's end, under T3 Code's line. Nothing when the box gave none of them. */
export function JobDetails({
  burrow,
  conversationId,
  handoff,
}: {
  burrow: string;
  conversationId: string;
  handoff: Handoff;
}) {
  const question = jobQuestion(handoff);
  const plan = jobPlan(handoff);
  const pullRequest = jobPullRequest(handoff);
  const changes = jobChanges(handoff, 6);
  const checks = jobChecks(handoff);
  const receipt = jobReceipt(handoff);
  const canMessage = jobCanMessage(handoff);
  if (!question && !plan && !pullRequest && !changes && !checks && !receipt && !canMessage) return null;
  return (
    <section className={styles.job} data-job-details={handoff.state}>
      {receipt && <Receipt handoff={handoff} />}
      {question && <QuestionBox burrow={burrow} conversationId={conversationId} question={question} />}
      {plan && <Plan key={`${handoff.id}:${plan.open}`} plan={plan} />}
      {pullRequest && (
        <div className={styles.part} data-job-pull-request={pullRequest.state}>
          <div className={styles.partHead}>
            <span className={styles.partTitle}>{JOB_WORDS.pullRequest.title}</span>
            <a
              className={styles.prLink}
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={pullRequest.spoken}
            >
              <Icon icon={GitPullRequest} size={13} />
              {pullRequest.text}
            </a>
          </div>
        </div>
      )}
      {changes && (
        <div className={styles.part} data-job-changes="">
          <div className={styles.partHead}>
            <span className={styles.partTitle}>{JOB_WORDS.changes.title}</span>
            <span className={styles.partCount}>{changes.summary}</span>
            {changes.url && (
              <a className={styles.partLink} href={changes.url} target="_blank" rel="noopener noreferrer">
                <Icon icon={GitPullRequest} size={13} />
                {JOB_WORDS.changes.open}
              </a>
            )}
          </div>
          {changes.title && <p className={styles.summary}>{changes.title}</p>}
          <ul className={styles.files}>
            {changes.files.map((f) => (
              <li key={f.path} className={styles.file} aria-label={f.spoken}>
                <span className={styles.fileName} aria-hidden="true">
                  <span className={styles.fileDir}>{f.dir}</span>
                  {f.name}
                </span>
                <span className={styles.plus} aria-hidden="true">
                  {f.plus}
                </span>
                <span className={styles.minus} aria-hidden="true">
                  {f.minus}
                </span>
              </li>
            ))}
          </ul>
          {changes.more && <p className={styles.more}>{changes.more}</p>}
        </div>
      )}
      {checks && (
        <div className={styles.part} data-job-checks="">
          <div className={styles.partHead}>
            <span className={styles.partTitle}>{JOB_WORDS.checks.title}</span>
            <span className={styles.partCount}>{checks.count}</span>
          </div>
          {checks.failure && (
            <p className={styles.failure} role="status" data-job-failure="">
              {checks.failure}
            </p>
          )}
          <ul className={styles.checks}>
            {checks.rows.map((c) => (
              <li key={c.name} className={styles.check} data-tone={c.tone}>
                <span className={styles.checkDot} aria-hidden="true" />
                {c.url ? (
                  <a className={styles.checkName} href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.name}
                  </a>
                ) : (
                  <span className={styles.checkName}>{c.name}</span>
                )}
                <span className={styles.checkWord}>{c.word}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canMessage && <MessageBox burrow={burrow} conversationId={conversationId} handoffId={handoff.id} />}
    </section>
  );
}

function Plan({ plan }: { plan: NonNullable<ReturnType<typeof jobPlan>> }) {
  const [open, setOpen] = useState(plan.open);
  const id = useId();
  return (
    <div className={styles.part} data-job-plan="">
      <button
        type="button"
        className={styles.planToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.partTitle}>{JOB_WORDS.plan.title}</span>
        <span className={styles.partCount}>{plan.count}</span>
        <span className={styles.toggleWord}>{open ? JOB_WORDS.plan.hide : JOB_WORDS.plan.show}</span>
      </button>
      {open && (
        <ol className={styles.plan} id={id}>
          {plan.rows.map((r) => (
            <li key={r.text} className={styles.planRow} data-state={r.state} aria-label={r.spoken}>
              <span className={styles.planMark} aria-hidden="true">
                {r.state === 'done' && <Icon icon={Check} size={10} />}
              </span>
              <span aria-hidden="true">{r.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function QuestionBox({
  burrow,
  conversationId,
  question,
}: {
  burrow: string;
  conversationId: string;
  question: JobQuestion;
}) {
  const { answer } = useJobActions(burrow, conversationId);
  const toast = useToast();
  const [sent, setSent] = useState<string | null>(null);
  const pick = async (label: string, answers: Record<string, string>) => {
    try {
      const r = await answer.mutateAsync({
        handoffId: question.handoffId,
        requestId: question.requestId,
        answers,
      });
      if (r.status === 'ok') {
        setSent(label);
        toast.show(JOB_WORDS.question.answered(label));
      } else toast.show(outcomeText(r));
    } catch (err) {
      toast.show(refusalText(err, JOB_WORDS.question.failed));
    }
  };
  return (
    <div className={styles.question} data-job-question="">
      <span className={styles.partTitle}>{JOB_WORDS.question.title}</span>
      <p className={styles.questionText}>{question.text}</p>
      {!question.multiSelect && question.options.length > 0 && (
        <div className={styles.options}>
          {question.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className={cx(styles.option, sent === o.label && styles.optionSent)}
              disabled={answer.isPending || sent !== null}
              onClick={() => void pick(o.label, o.answers)}
              title={o.description ?? undefined}
            >
              <span className={styles.optionLabel}>{o.label}</span>
              {o.description && <span className={styles.optionHint}>{o.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBox({
  burrow,
  conversationId,
  handoffId,
}: {
  burrow: string;
  conversationId: string;
  handoffId: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'steer' | 'queue'>('steer');
  const input = useRef<HTMLTextAreaElement>(null);
  const { send } = useJobActions(burrow, conversationId);
  const toast = useToast();
  const close = () => {
    setOpen(false);
    setText('');
  };
  const submit = async () => {
    const t = text.trim();
    if (!t || send.isPending) return;
    try {
      const r = await send.mutateAsync({ handoffId, text: t, mode });
      if (r.status !== 'ok') {
        toast.show(outcomeText(r));
        return;
      }
      toast.show(mode === 'steer' ? JOB_WORDS.message.sentNow : JOB_WORDS.message.sentNext);
      close();
    } catch (err) {
      toast.show(refusalText(err, JOB_WORDS.message.failed));
    }
  };
  if (!open)
    return (
      <button
        type="button"
        className={styles.messageOpen}
        onClick={() => setOpen(true)}
        data-job-message-open=""
      >
        <Icon icon={MessageSquare} size={14} />
        {JOB_WORDS.message.open}
      </button>
    );
  return (
    <form
      className={styles.message}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-job-message=""
    >
      <textarea
        ref={input}
        // biome-ignore lint/a11y/noAutofocus: the person pressed Message T3 Code to type it
        autoFocus
        className={styles.messageInput}
        rows={2}
        value={text}
        placeholder={JOB_WORDS.message.placeholder}
        aria-label={JOB_WORDS.message.open}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className={styles.messageActions}>
        <fieldset className={styles.modes}>
          <legend className={styles.srOnly}>{JOB_WORDS.message.open}</legend>
          {(['steer', 'queue'] as const).map((m) => (
            <label key={m} className={styles.mode} data-on={mode === m ? '' : undefined}>
              <input
                type="radio"
                name={`job-mode-${handoffId}`}
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className={styles.srOnly}
              />
              {m === 'steer' ? JOB_WORDS.message.now : JOB_WORDS.message.next}
            </label>
          ))}
        </fieldset>
        <span className={styles.modeHint}>
          {mode === 'steer' ? JOB_WORDS.message.nowHint : JOB_WORDS.message.nextHint}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {JOB_WORDS.message.close}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || send.isPending}>
          {mode === 'steer' ? JOB_WORDS.message.now : JOB_WORDS.message.next}
        </Button>
      </div>
    </form>
  );
}

function Receipt({ handoff }: { handoff: Handoff }) {
  const r = jobReceipt(handoff);
  if (!r) return null;
  return (
    <div className={styles.receipt} data-tone={r.tone} data-job-receipt="">
      <div className={styles.receiptHead}>
        <span className={styles.receiptMark} aria-hidden="true">
          {r.tone === 'bad' ? <Icon icon={X} size={12} /> : <Icon icon={Check} size={12} />}
        </span>
        <strong className={styles.receiptTitle}>{r.title}</strong>
      </div>
      {r.summary && <p className={styles.receiptSummary}>{r.summary}</p>}
      {r.lines.length > 0 && (
        <ul className={styles.receiptLines}>
          {r.lines.map((l) => (
            <li
              key={l.key}
              data-tone={l.tone ?? undefined}
              className={l.key === 'model' ? styles.mono : undefined}
            >
              {l.url ? (
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.text}
                </a>
              ) : (
                l.text
              )}
            </li>
          ))}
        </ul>
      )}
      {r.screenshot && (
        <img
          className={styles.shot}
          src={r.screenshot.url}
          alt={r.screenshot.alt || JOB_WORDS.receipt.screenshot}
        />
      )}
      {/* A new run's answer starts folded again. */}
      <Answer key={`${handoff.id}:${handoff.endedAt}`} handoff={handoff} />
    </div>
  );
}

/**
 * T3 Code's whole answer, folded under the receipt until the person opens it, as a council member's on its row: read in
 * the thread, with a link to T3 Code when the thread keeps only its start.
 */
function Answer({ handoff }: { handoff: Handoff }) {
  const answer = jobAnswer(handoff);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!answer) return null;
  return (
    <div className={styles.answerPart} data-job-answer={open ? 'open' : 'folded'}>
      <button
        type="button"
        className={styles.answerToggle}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? JOB_WORDS.answer.hide : JOB_WORDS.answer.read}
      </button>
      {open && (
        <div id={id} className={styles.answer}>
          <RichText text={answer.text} className={styles.answerText} />
          {answer.cut && answer.url && (
            <a className={styles.answerRest} href={answer.url} target="_blank" rel="noopener noreferrer">
              {JOB_WORDS.answer.rest}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
