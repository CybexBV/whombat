// The investigation panel (docs/ASSIST.md 7): a side panel on the right of
// any page while `?investigation=<id>` is in the URL, full screen on
// phones. Header with the title, host, provider and model, state, cost,
// Stop and Delete; the transcript (Markdown answers, one line per tool step
// that expands to its input and output, approval cards with Run / Decline,
// the summary) following the newest event unless the reader scrolled up;
// a reply box (Enter sends, Shift+Enter is a new line). Live through SSE:
// api/assist.ts appends the events to the cached detail.

import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { assistApi, type Investigation, type InvestigationDetail, useDeleteInvestigation, useInvestigation, useInvestigationChange } from '../../api/assist';
import { ApiError } from '../../api/client';
import { useAuthState } from '../../api/queries';
import { Skeleton } from '../../components/common';
import { Dot } from '../../components/controls';
import { errorText } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { formatFull, formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { Markdown } from '../../lib/markdown';
import { hostPath } from '../../lib/urlState';
import { useReturnFocus } from '../../lib/useReturnFocus';
import { costText, isActive, providerLine, stateColor, stateText } from './labels';
import { INVESTIGATION_PARAM, keepOpen, useOpenInvestigation } from './open';
import { type ApprovalDecided, buildTranscript, inputRows, stepDuration, type ToolEvent, type ToolResult, type TranscriptItem } from './transcript';

/** The panel of `?investigation=<id>`, admins only (mounted once in the shell). */
export function InvestigationHost() {
  const [params] = useSearchParams();
  const id = params.get(INVESTIGATION_PARAM);
  const auth = useAuthState();
  const admin = auth.data?.user?.role === 'admin' && !auth.data.kiosk;
  const open = !!id && admin;
  const setOpen = useOpenInvestigation();
  useReturnFocus(open);
  if (!open) return null;
  return <InvestigationPanel key={id} id={id} onClose={() => setOpen(null)} />;
}

export function StateChip({ i }: { i: Pick<Investigation, 'state' | 'resolved'> }) {
  const working = i.state === 'starting' || i.state === 'running';
  return (
    <span className="chip inv-state">
      {working ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Dot color={stateColor(i)} />}
      {stateText(i)}
    </span>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="modal-x inv-x" aria-label={t('Close the investigation')} title={t('Close')} onClick={onClose}>
      <Icon name="close" size={16} />
    </button>
  );
}

function InvestigationPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useInvestigation(id);
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const onKey = (e: KeyboardEvent) => {
    // Escape inside a dialog opened from the panel closes that dialog only.
    if (e.key !== 'Escape' || e.defaultPrevented || (e.target as Element).closest?.('dialog')) return;
    e.preventDefault();
    onClose();
  };
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  return (
    <section ref={ref} className="inv-panel" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKey}>
      {q.data ? (
        <>
          <PanelHeader i={q.data.investigation} titleId={titleId} onClose={onClose} />
          <Transcript d={q.data} />
          <ReplyBox i={q.data.investigation} />
        </>
      ) : (
        <div className="inv-head">
          <div className="inv-head-row">
            <h2 className="inv-title" id={titleId}>
              {notFound ? t('Investigation not found') : q.isError ? t('Could not load the investigation') : t('Loading the investigation…')}
            </h2>
            <CloseButton onClose={onClose} />
          </div>
          {notFound ? (
            <p className="ink-2">{t('It was deleted, or the link is wrong.')}</p>
          ) : q.isError ? (
            <InlineRetry title={t('Could not load the investigation')} error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <Skeleton height={160} />
          )}
        </div>
      )}
    </section>
  );
}

function PanelHeader({ i, titleId, onClose }: { i: Investigation; titleId: string; onClose: () => void }) {
  const stop = useInvestigationChange(() => assistApi.stop(i.id));
  const del = useDeleteInvestigation();
  const [confirm, setConfirm] = useState(false);
  const cost = costText(i.cost_usd);
  return (
    <header className="inv-head">
      <div className="inv-head-row">
        <h2 className="inv-title" id={titleId}>
          {i.title}
        </h2>
        <Menu label={t('More for this investigation')} items={[{ label: t('Delete…'), icon: 'trash', danger: true, onSelect: () => setConfirm(true) }]} />
        <CloseButton onClose={onClose} />
      </div>
      <div className="inv-meta">
        <StateChip i={i} />
        {i.server ? (
          <Link className="mono ink" to={keepOpen(hostPath(i.server), i.id)}>
            {i.server_name ?? i.server}
          </Link>
        ) : (
          <span>{t('All hosts')}</span>
        )}
        <span>{providerLine(i)}</span>
        {cost && <span title={t('Claude Code’s estimate; subscriptions are not billed per call')}>{cost}</span>}
        {isActive(i.state) && (
          <button
            type="button"
            className="btn-ghost row-action inv-stop"
            disabled={stop.isPending}
            onClick={() => stop.mutate(undefined, { onError: (err) => toast(t('Could not stop the investigation: {error}', { error: errorText(err) }), 'error') })}
          >
            <Icon name="square" size={12} />
            {stop.isPending ? t('Stopping…') : t('Stop')}
          </button>
        )}
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        busy={del.isPending}
        tone="serious"
        title={t('Delete this investigation?')}
        description={t('Its transcript is deleted. The audit log keeps the commands and actions it ran.')}
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => setConfirm(false)} disabled={del.isPending}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="btn-primary is-serious"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(i.id, {
                  onSuccess: () => {
                    setConfirm(false);
                    toast(t('Investigation deleted.'), 'success');
                    onClose();
                  },
                  onError: (err) => toast(t('Could not delete the investigation: {error}', { error: errorText(err) }), 'error'),
                })
              }
            >
              {t('Delete')}
            </button>
          </>
        }
      />
    </header>
  );
}

// ---------------------------------------------------------------- transcript

function Transcript({ d }: { d: InvestigationDetail }) {
  const i = d.investigation;
  const items = useMemo(() => buildTranscript(d.events), [d.events]);
  const log = useRef<HTMLDivElement>(null);
  // Follow the newest event unless the reader scrolled up.
  const stick = useRef(true);
  const working = i.state === 'starting' || i.state === 'running';
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, working]);
  return (
    <div
      ref={log}
      className="inv-log"
      role="log"
      aria-label={t('Transcript')}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
    >
      {items.map((it) => (
        <Item key={it.seq} it={it} i={i} />
      ))}
      {working && (
        <div className="inv-working lbl">
          <span className="spinner spinner-sm" aria-hidden="true" />
          {t('The assistant is working…')}
        </div>
      )}
      {!items.length && !working && <p className="lbl">{t('Nothing here yet.')}</p>}
    </div>
  );
}

const STATUS_TEXT: Partial<Record<Investigation['state'], string>> = { stopped: t('Stopped'), failed: t('Failed') };

function Item({ it, i }: { it: TranscriptItem; i: Investigation }) {
  switch (it.kind) {
    case 'user': {
      const at = Date.parse(it.at);
      return (
        <div className="inv-user">
          <div className="inv-user-by lbl">
            {it.by === 'auto' ? t('Started automatically') : it.by}
            {Number.isFinite(at) && (
              <>
                {' · '}
                <time dateTime={it.at} title={formatFull(at)}>
                  {formatTime(at)}
                </time>
              </>
            )}
          </div>
          <div className="inv-user-text">{it.text}</div>
        </div>
      );
    }
    case 'assistant':
      return <Markdown className="inv-md" text={it.text} />;
    case 'step':
      return <Step tool={it.tool} result={it.result} />;
    case 'approval':
      return <ApprovalCard i={i} it={it} />;
    case 'status':
      return (
        <div className="inv-status lbl">
          <span>{it.text ?? STATUS_TEXT[it.state] ?? it.state}</span>
        </div>
      );
    case 'summary':
      return (
        <div className={it.resolved ? 'inv-summary is-resolved' : 'inv-summary is-attention'}>
          <div className="inv-summary-head">
            <Icon name={it.resolved ? 'check' : 'warning'} size={15} />
            {it.resolved ? t('Resolved') : t('Needs attention')}
          </div>
          <Markdown text={it.text} />
        </div>
      );
    case 'error':
      return (
        <div className="inv-error">
          <Icon name="critical" size={15} />
          <span>{it.text}</span>
        </div>
      );
  }
}

/** A tool's output in a scrollable monospace block. */
function Output({ result, title }: { result: ToolResult; title: string }) {
  return (
    <>
      <pre className="inv-out" tabIndex={0} aria-label={t('Output of {step}', { step: title })}>
        {result.output || t('(no output)')}
      </pre>
      {result.truncated && <p className="lbl">{t('The output was cut short.')}</p>}
    </>
  );
}

function StepIcon({ result }: { result: ToolResult | null }) {
  if (!result) return <span className="spinner spinner-sm" aria-hidden="true" />;
  return (
    <span className={result.ok ? 'inv-step-ic is-ok' : 'inv-step-ic is-fail'}>
      <Icon name={result.ok ? 'check' : 'critical'} size={14} />
    </span>
  );
}

/** One line per tool call ("✓ SMART data · blackbox"), expanding to its input and output. */
function Step({ tool, result }: { tool: ToolEvent; result: ToolResult | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rows: [string, string][] = [[t('Tool'), tool.tool], ...inputRows(tool.input)];
  return (
    <div className={open ? 'inv-step is-open' : 'inv-step'}>
      <button type="button" className="inv-step-line" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        <StepIcon result={result} />
        <span className="inv-step-title">
          {tool.title}
          {tool.server && <span className="inv-step-host"> · {tool.server}</span>}
        </span>
        <span className="sr-only">{!result ? t('running') : result.ok ? t('done') : t('failed')}</span>
        {result && <span className="inv-step-dur">{stepDuration(result.duration_ms)}</span>}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} className="inv-step-chev" />
      </button>
      {open && (
        <div className="inv-step-body" id={id}>
          <dl className="inv-args">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {result ? <Output result={result} title={tool.title} /> : <p className="lbl">{t('Running…')}</p>}
        </div>
      )}
    </div>
  );
}

function Decision({ d }: { d: ApprovalDecided }) {
  const reply = d.reply ? ` · “${d.reply}”` : '';
  switch (d.decision) {
    case 'approved':
      return (
        <div className="inv-decision is-approved">
          <Icon name="check" size={14} />
          <span>
            {t('Approved by {name}', { name: d.by })}
            {reply}
          </span>
        </div>
      );
    case 'declined':
      return (
        <div className="inv-decision is-declined">
          <Icon name="close" size={14} />
          <span>
            {t('Declined by {name}', { name: d.by })}
            {reply}
          </span>
        </div>
      );
    default:
      return (
        <div className="inv-decision">
          <Icon name="clock" size={14} />
          <span>{t('Expired: nobody decided within 30 minutes')}</span>
        </div>
      );
  }
}

/** A command or guest action waiting for the admin (access "ask"), then its decision and output. */
function ApprovalCard({ i, it }: { i: Investigation; it: Extract<TranscriptItem, { kind: 'approval' }> }) {
  const a = it.approval;
  const headId = useId();
  const [reply, setReply] = useState('');
  const [output, setOutput] = useState(false);
  const decide = useInvestigationChange((approve: boolean) => assistApi.decide(i.id, a.approval_id, approve, reply.trim() || undefined));
  const choose = (approve: boolean) =>
    decide.mutate(approve, { onError: (err) => toast(t('Could not send the decision: {error}', { error: errorText(err) }), 'error') });
  const pending = !it.decision;
  const cmd = a.action === 'command';
  const head = pending
    ? cmd
      ? t('Run this command on {host}?', { host: a.server })
      : t('Run this action on {host}?', { host: a.server })
    : cmd
      ? t('Command on {host}', { host: a.server })
      : t('Action on {host}', { host: a.server });
  const outTitle = it.tool?.title ?? a.command;
  return (
    <div className={pending ? 'inv-approval is-pending' : 'inv-approval'} role="group" aria-labelledby={headId}>
      <div className="inv-approval-head" id={headId}>
        <Icon name={cmd ? 'terminal' : 'power'} size={15} />
        <span>{head}</span>
      </div>
      <pre className="inv-cmd" tabIndex={0} aria-label={cmd ? t('Command') : t('Action')}>
        {a.command}
      </pre>
      {a.reason && <p className="inv-reason">{a.reason}</p>}
      {pending ? (
        <form
          className="inv-approval-form"
          onSubmit={(e) => {
            e.preventDefault();
            choose(true);
          }}
        >
          <input
            className="input"
            type="text"
            value={reply}
            maxLength={2000}
            placeholder={t('Reply (optional)')}
            aria-label={t('Reply with your decision (optional)')}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="inv-approval-actions">
            <button type="button" className="btn-ghost" disabled={decide.isPending} onClick={() => choose(false)}>
              {t('Decline')}
            </button>
            <button type="submit" className="btn-primary" disabled={decide.isPending}>
              {cmd ? <Icon name="terminal" size={14} /> : <Icon name="power" size={14} />}
              {t('Run')}
            </button>
          </div>
        </form>
      ) : (
        <Decision d={it.decision!} />
      )}
      {it.result && (
        <>
          <button type="button" className="inv-step-line inv-out-toggle" aria-expanded={output} onClick={() => setOutput((o) => !o)}>
            <StepIcon result={it.result} />
            <span className="inv-step-title">{t('Output')}</span>
            <span className="inv-step-dur">{stepDuration(it.result.duration_ms)}</span>
            <Icon name={output ? 'chevronUp' : 'chevronDown'} size={14} className="inv-step-chev" />
          </button>
          {output && <Output result={it.result} title={outTitle} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reply

function ReplyBox({ i }: { i: Investigation }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const send = useInvestigationChange((v: string) => assistApi.send(i.id, v));
  const submit = () => {
    const v = text.trim();
    if (!v || send.isPending) return;
    send.mutate(v, {
      onSuccess: () => setText(''),
      onError: (err) => toast(t('Could not send the reply: {error}', { error: errorText(err) }), 'error'),
      // The box is disabled while sending: give the focus back.
      onSettled: () => setTimeout(() => input.current?.focus(), 0),
    });
  };
  return (
    <form
      className="inv-reply"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={input}
        className="input inv-reply-input"
        rows={2}
        value={text}
        maxLength={8000}
        disabled={send.isPending}
        placeholder={t('Reply or give the assistant more context…')}
        aria-label={t('Reply to the assistant')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" className="btn-primary inv-send" disabled={send.isPending || !text.trim()} aria-label={t('Send')} title={t('Send (Enter)')}>
        {send.isPending ? <span className="spinner spinner-sm on-primary" aria-hidden="true" /> : <Icon name="send" size={15} />}
      </button>
    </form>
  );
}
