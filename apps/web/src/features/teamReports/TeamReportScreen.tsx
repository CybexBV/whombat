/**
 * One report (`/reports/<reportId>`): its title, number and kind,
 * the status in words and the four steps, then the conversation oldest first (a quiet line above it when the oldest
 * messages of a long one were left out) — what the person sent, the team's
 * answers as “Whombat Team”, status changes as quiet lines — and a box to write to the team. The team's words are plain
 * text only: no formatting, links not clickable, no pictures. It works / Still happening once a fix is available or
 * the report was closed, until 30 days after closing; Withdraw report in ⋯, after asking. Opening the page reads the
 * report (the box marks it read).
 */
import { useNavigate } from '@tanstack/react-router';
import { WhombatLogo } from '@whombat/brand/react';
import {
  TEAM_REPORT_KIND_WORDS,
  TEAM_REPORT_WORDS,
  type TeamReportEntry,
  teamReportMessageWhen,
  teamReportTimeline,
} from '@whombat/client';
import {
  teamReportErrorText,
  teamReportMissing,
  useActTeamReport,
  useBootstrapSelect,
  useReplyTeamReport,
  useTeamReport,
} from '@whombat/client/react';
import {
  type Bootstrap,
  TEAM_REPORT_MESSAGES_MAX,
  TEAM_REPORT_REPLY_MAX,
  TEAM_REPORT_STATUS_WORDS,
  type TeamReport,
  type TeamReportAction,
  teamReportCanConfirmNow,
  teamReportNeedsYou,
  teamReportOpen,
} from '@whombat/core';
import { Ellipsis, MessageSquareText } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useSearchUpdate } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { PersonAvatar } from '../messaging/PersonAvatar';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { errorDetail, PlacePage, PlaceState } from '../settings/Place';
import { BackToReports, KindIcon, ReportTrack } from './parts';
import styles from './TeamReports.module.css';

const selectMe = (b: Bootstrap) => b.me;

export function TeamReportScreen({
  burrow,
  reportId,
  sent = false,
}: {
  burrow: string;
  reportId: string;
  /** Just sent from the form: the page says so once. */
  sent?: boolean;
}) {
  const query = useTeamReport(burrow, reportId);
  const updateSearch = useSearchUpdate();
  // “Sent.” stays while the page is open; the address loses `?sent=1`, so a reload doesn't say it again.
  const [justSent] = useState(sent);
  useEffect(() => {
    if (sent) void updateSearch((s) => ({ ...s, sent: undefined }), { replace: true });
  }, [sent, updateSearch]);

  // A report that is gone (withdrawn, or 90 days after closing) says so, even where an older answer is still cached.
  const missing = query.error ? teamReportMissing(query.error) : false;
  const report = missing ? undefined : query.report;
  if (report)
    return <ReportPage burrow={burrow} report={report} earlier={query.earlier} justSent={justSent} />;
  return (
    <PlacePage title={TEAM_REPORT_WORDS.title} back={<BackToReports />} screen="team-report">
      {!query.supported ? (
        <PlaceState kind="empty" icon={MessageSquareText} title={TEAM_REPORT_WORDS.updateFirst} />
      ) : query.error ? (
        missing ? (
          <PlaceState kind="empty" icon={MessageSquareText} title={TEAM_REPORT_WORDS.notFound} />
        ) : (
          <PlaceState
            kind="failed"
            icon={MessageSquareText}
            title={TEAM_REPORT_WORDS.reportFailed}
            onRetry={() => void query.refetch()}
            detail={errorDetail(query.error)}
          />
        )
      ) : (
        <PlaceState kind="loading" icon={MessageSquareText} title={TEAM_REPORT_WORDS.loading} />
      )}
    </PlacePage>
  );
}

function ReportPage({
  burrow,
  report,
  earlier,
  justSent,
}: {
  burrow: string;
  report: TeamReport;
  /** How many of the oldest messages the answer left out. */
  earlier: number;
  justSent: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const act = useActTeamReport(burrow, report.id);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawProblem, setWithdrawProblem] = useState<string | null>(null);
  const needsYou = teamReportNeedsYou(report.status);
  const now = useNow(60_000);

  const press = async (action: TeamReportAction) => {
    try {
      await act.mutateAsync(action);
      return true;
    } catch (error) {
      if (action === 'withdraw') setWithdrawProblem(teamReportErrorText(error));
      else toast.show(teamReportErrorText(error));
      return false;
    }
  };

  return (
    <PlacePage
      title={report.title}
      back={
        // ⋯ on the way back's line, so it stays at the page's top corner at every width.
        <div className={styles.backRow}>
          <BackToReports />
          <ReportMenu onWithdraw={() => setWithdrawing(true)} />
        </div>
      }
      screen="team-report"
      intro={
        <span className={styles.meta}>
          <span className={styles.number}>#{report.number}</span>
          <span aria-hidden="true">·</span>
          <span className={styles.kindWord}>
            <KindIcon kind={report.kind} size={14} />
            {TEAM_REPORT_KIND_WORDS[report.kind]}
          </span>
          <span className={styles.status} data-needs-you={needsYou || undefined} data-report-status="">
            {TEAM_REPORT_STATUS_WORDS[report.status]}
          </span>
        </span>
      }
    >
      {justSent ? (
        <p className={styles.sentNote} role="status" data-report-sent="">
          {TEAM_REPORT_WORDS.sent}
        </p>
      ) : null}
      <ReportTrack status={report.status} />
      {teamReportCanConfirmNow(report, Math.floor(now / 1000)) ? (
        <div className={styles.confirm} data-report-confirm="">
          <p>{TEAM_REPORT_WORDS.confirmQuestion}</p>
          <Button variant="primary" disabled={act.isPending} onClick={() => void press('works')}>
            {TEAM_REPORT_WORDS.works}
          </Button>
          <Button variant="secondary" disabled={act.isPending} onClick={() => void press('still_happening')}>
            {TEAM_REPORT_WORDS.stillHappening}
          </Button>
        </div>
      ) : null}
      {earlier > 0 ? (
        <p className={styles.quiet} data-report-earlier="">
          {TEAM_REPORT_WORDS.earlier}
        </p>
      ) : null}
      <Conversation burrow={burrow} report={report} earlier={earlier} />
      {teamReportOpen(report.status) ? (
        report.messages.length + earlier >= TEAM_REPORT_MESSAGES_MAX ? (
          <p className={styles.quiet}>{TEAM_REPORT_WORDS.full}</p>
        ) : (
          <ReplyBox burrow={burrow} reportId={report.id} />
        )
      ) : null}
      {withdrawing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setWithdrawing(false);
              setWithdrawProblem(null);
            }
          }}
          kicker={TEAM_REPORT_WORDS.withdraw.toUpperCase()}
          title="Withdraw this report?"
          confirmLabel={TEAM_REPORT_WORDS.withdraw}
          cancelLabel={TEAM_REPORT_WORDS.cancel}
          busy={act.isPending}
          error={withdrawProblem}
          onConfirm={() => {
            void press('withdraw').then((ok) => {
              if (!ok) return;
              toast.show(TEAM_REPORT_WORDS.withdrawn);
              void navigate({ to: '/reports' });
            });
          }}
        >
          It is deleted, also from the Whombat Team’s list of reports.
        </ConfirmDialog>
      ) : null}
    </PlacePage>
  );
}

/**
 * ⋯ at the end of the head: Withdraw report. Escape or a click elsewhere closes it; Escape and the choice give the focus
 * back to ⋯ (the dialog the choice opens gives it back there too).
 */
function ReportMenu({ onWithdraw }: { onWithdraw: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        setOpen(false);
        button.current?.focus();
      } else if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={wrap} className={styles.menuWrap}>
      <button
        ref={button}
        type="button"
        className={styles.more}
        aria-label={TEAM_REPORT_WORDS.more}
        title={TEAM_REPORT_WORDS.more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
        data-report-more=""
      >
        <Icon icon={Ellipsis} size={16} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu" id={menuId} aria-label={TEAM_REPORT_WORDS.more}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              button.current?.focus();
              onWithdraw();
            }}
          >
            {TEAM_REPORT_WORDS.withdraw}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The conversation, oldest first, in Chat's rows. */
function Conversation({ burrow, report, earlier }: { burrow: string; report: TeamReport; earlier: number }) {
  const { timeZone } = useBurrowContext(burrow);
  const me = useBootstrapSelect(burrow, selectMe);
  const now = useNow(60_000);
  const entries = teamReportTimeline(report, earlier);
  return (
    <ol className={styles.thread} aria-label="Conversation" data-report-thread="">
      {entries.map((entry) => (
        <li key={entry.key}>
          <Entry entry={entry} me={me} when={teamReportMessageWhen(entry.at, now, timeZone)} />
        </li>
      ))}
    </ol>
  );
}

function Entry({
  entry,
  me,
  when,
}: {
  entry: TeamReportEntry;
  me: Bootstrap['me'] | undefined;
  when: string;
}) {
  if (entry.kind === 'status')
    return (
      <p className={styles.statusLine} data-report-status-line="">
        <span>
          <b>{entry.words}</b> · {when}
        </span>
      </p>
    );
  const team = entry.kind === 'message' && entry.author === 'team';
  return (
    <article className={styles.message} data-author={team ? 'team' : 'reporter'}>
      {team ? (
        <span className={`${styles.face} ${styles.teamFace}`} aria-hidden="true">
          <WhombatLogo height={22} />
        </span>
      ) : (
        <span className={styles.face} aria-hidden="true">
          {me ? (
            <PersonAvatar avatarUrl={me.avatarUrl} initials={me.initials} tone={me.tone} size={32} />
          ) : null}
        </span>
      )}
      <div className={styles.messageContent}>
        <div className={styles.messageMeta}>
          <span className={styles.name}>{team ? TEAM_REPORT_WORDS.team : TEAM_REPORT_WORDS.you}</span>
          <span className={styles.messageTime}>{when}</span>
        </div>
        <p className={styles.text}>{entry.text}</p>
        {entry.kind === 'sent' && entry.expected.trim() ? (
          <div className={styles.expected}>
            <span className={styles.expectedLabel}>{TEAM_REPORT_WORDS.expected}</span>
            <p className={styles.text}>{entry.expected}</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** “Write to the Whombat Team”: the words stay when sending fails. */
function ReplyBox({ burrow, reportId }: { burrow: string; reportId: string }) {
  const reply = useReplyTeamReport(burrow, reportId);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const words = text.trim();
    if (!words || reply.isPending) return;
    setProblem(null);
    try {
      await reply.mutateAsync(words);
      setText('');
    } catch (error) {
      setProblem(teamReportErrorText(error));
    }
  };
  return (
    <form className={styles.reply} onSubmit={(e) => void send(e)} data-report-reply="">
      <label className={styles.srOnly} htmlFor={id}>
        {TEAM_REPORT_WORDS.reply}
      </label>
      <textarea
        id={id}
        className={styles.textarea}
        rows={3}
        maxLength={TEAM_REPORT_REPLY_MAX}
        placeholder={TEAM_REPORT_WORDS.reply}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={styles.replyActions}>
        <Button type="submit" variant="primary" disabled={!text.trim() || reply.isPending}>
          {reply.isPending ? TEAM_REPORT_WORDS.sending : TEAM_REPORT_WORDS.replySend}
        </Button>
      </div>
    </form>
  );
}
