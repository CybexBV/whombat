/**
 * New report (`/reports/new`): Something’s wrong or An idea, one question that
 * must be answered, “What did you expect?” for a problem, what is sent with it (folded; the Whombat's version and update
 * channel named even before the app knows them), the quiet warning that the
 * team and its AI assistant read it, where a security problem goes instead, and Send. `?draft=<id>` fills it with the
 * assistant's draft (its card's Edit); a draft already sent or put aside fills nothing. After Send the report's page
 * opens and says it was sent.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  browserDeviceWords,
  TEAM_REPORT_SECURITY_URL,
  TEAM_REPORT_WORDS,
  teamReportClientContext,
  teamReportSentWith,
  teamReportSentWithLine,
  teamReportsUnavailableText,
} from '@whombat/client';
import { readUpdatesChannel } from '@whombat/client/managed';
import {
  teamReportErrorText,
  useCreateTeamReport,
  useTeamReportDraft,
  useTeamReports,
} from '@whombat/client/react';
import { TEAM_REPORT_EXPECTED_MAX, TEAM_REPORT_TEXT_MAX, type TeamReportKind } from '@whombat/core';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { PlacePage } from '../settings/Place';
import { appVersions, useWhombatVersions } from '../settings/version';
import { BackToReports, KindIcon } from './parts';
import styles from './TeamReports.module.css';

const KINDS: readonly TeamReportKind[] = ['bug', 'idea'];

/** The Whombat's update channel, which it adds to a report itself: read here only to show it. Null while unknown. */
function useUpdateChannel() {
  const { managed, session } = useAppServices();
  const channel = useQuery({
    queryKey: ['whombat', 'updates.channel'],
    queryFn: () => readUpdatesChannel(session),
    enabled: Boolean(managed),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return channel.data?.channel ?? null;
}

/** What this web app says about itself: its version, the browser and system, the language. */
function webContext() {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return teamReportClientContext({
    client: 'web',
    appVersion: appVersions().app,
    device: nav ? browserDeviceWords(nav.userAgent) : null,
    language: nav?.language ?? null,
  });
}

export function NewTeamReportScreen({ burrow, draftId }: { burrow: string; draftId?: string | undefined }) {
  const navigate = useNavigate();
  const ids = useId();
  const list = useTeamReports(burrow);
  const draft = useTeamReportDraft(burrow, draftId);
  const create = useCreateTeamReport(burrow);
  const versions = useWhombatVersions();
  const [kind, setKind] = useState<TeamReportKind>('bug');
  const [text, setText] = useState('');
  const [expected, setExpected] = useState('');
  const [sentWithOpen, setSentWithOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const context = useMemo(webContext, []);
  const channel = useUpdateChannel();
  const sentWith = {
    ...context,
    ...(versions.runtime ? { runtimeVersion: versions.runtime } : {}),
    ...(channel ? { channel } : {}),
  };

  // The assistant's draft fills the form once, unless it was already sent or put aside.
  const filled = useRef<string | null>(null);
  const shownDraft = draft.data?.draft;
  useEffect(() => {
    if (!shownDraft || shownDraft.done || filled.current === shownDraft.id) return;
    filled.current = shownDraft.id;
    setKind(shownDraft.kind);
    setText(shownDraft.text);
    setExpected(shownDraft.expected);
  }, [shownDraft]);

  const unavailable = list.data && !list.data.available ? teamReportsUnavailableText(list.data.reason) : null;
  const canSend = list.supported && !unavailable && text.trim().length > 0 && !create.isPending;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setProblem(null);
    try {
      const report = await create.mutateAsync({
        kind,
        text: text.trim(),
        expected: kind === 'bug' ? expected.trim() : '',
        context,
        ...(shownDraft && !shownDraft.done ? { draftId: shownDraft.id } : {}),
      });
      void navigate({ to: '/reports/$reportId', params: { reportId: report.id }, search: { sent: 1 } });
    } catch (error) {
      setProblem(teamReportErrorText(error));
    }
  };

  return (
    <PlacePage title={TEAM_REPORT_WORDS.formTitle} back={<BackToReports />} screen="team-report-new">
      {!list.supported ? (
        <p className={styles.quiet}>{TEAM_REPORT_WORDS.updateFirst}</p>
      ) : unavailable ? (
        <p className={styles.quiet}>{unavailable}</p>
      ) : null}
      {shownDraft?.done ? <p className={styles.quiet}>{TEAM_REPORT_WORDS.draftDone}</p> : null}
      {draftId && draft.isError ? <p className={styles.quiet}>{TEAM_REPORT_WORDS.draftFailed}</p> : null}
      <form className={styles.form} onSubmit={(e) => void send(e)} aria-busy={create.isPending || undefined}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>{TEAM_REPORT_WORDS.kindQuestion}</legend>
          <div className={styles.kinds}>
            {KINDS.map((k) => (
              <label key={k} className={styles.kind} data-kind={k}>
                <input
                  type="radio"
                  name={`${ids}-kind`}
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span className={styles.kindIcon} aria-hidden="true">
                  <KindIcon kind={k} />
                </span>
                <span className={styles.kindText}>
                  <span className={styles.kindTitle}>{TEAM_REPORT_WORDS.kinds[k].title}</span>
                  <span className={styles.kindHint}>{TEAM_REPORT_WORDS.kinds[k].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${ids}-text`}>
            {TEAM_REPORT_WORDS.textLabel[kind]}
          </label>
          <textarea
            id={`${ids}-text`}
            className={styles.textarea}
            required
            rows={5}
            maxLength={TEAM_REPORT_TEXT_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-report-text=""
          />
        </div>
        {kind === 'bug' ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${ids}-expected`}>
              {TEAM_REPORT_WORDS.expectedLabel}
              <span className={styles.optional}>{TEAM_REPORT_WORDS.optional}</span>
            </label>
            <textarea
              id={`${ids}-expected`}
              className={styles.textarea}
              rows={2}
              maxLength={TEAM_REPORT_EXPECTED_MAX}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </div>
        ) : null}
        <div className={styles.sentWith}>
          <button
            type="button"
            className={styles.sentWithToggle}
            aria-expanded={sentWithOpen}
            aria-controls={`${ids}-sent-with`}
            onClick={() => setSentWithOpen((was) => !was)}
          >
            <span>{TEAM_REPORT_WORDS.sentWith}</span>
            {sentWithOpen ? null : (
              <span className={styles.sentWithSummary}>{teamReportSentWithLine(sentWith)}</span>
            )}
            <Icon icon={sentWithOpen ? ChevronUp : ChevronDown} size={15} />
          </button>
          {sentWithOpen ? (
            <div id={`${ids}-sent-with`}>
              <dl className={styles.sentWithList}>
                {teamReportSentWith(sentWith).map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              <p className={cx(styles.quiet, styles.sentWithNote)}>{TEAM_REPORT_WORDS.sentWithNothingElse}</p>
            </div>
          ) : null}
        </div>
        <p className={styles.quiet} data-report-warning="">
          <Icon icon={ShieldCheck} size={15} />
          <span>{TEAM_REPORT_WORDS.warning}</span>
        </p>
        <p className={styles.quiet}>
          <span>
            {TEAM_REPORT_WORDS.securityQuestion}{' '}
            <a className={styles.inlineLink} href={TEAM_REPORT_SECURITY_URL} target="_blank" rel="noreferrer">
              {TEAM_REPORT_WORDS.securityLink}
            </a>
          </span>
        </p>
        {problem ? (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" size="lg" disabled={!canSend}>
            {create.isPending ? TEAM_REPORT_WORDS.sending : TEAM_REPORT_WORDS.send}
          </Button>
        </div>
      </form>
    </PlacePage>
  );
}
