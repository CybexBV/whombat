import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf, RUN_ATTENTION_LABEL } from '@whombat/client';
import {
  type AgentFace,
  formatAdditions,
  formatDeletions,
  type Grant,
  keyRows,
  type Run,
  type RunLogLine,
  runKeysScope,
  runKeysTitle,
} from '@whombat/core';
import { type MouseEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { currentLocale } from '../../i18n/provider';
import styles from './RunView.module.css';
import {
  type RunNotice,
  runAttention,
  runControls,
  runDot,
  runKicker,
  runNotice,
  stepViews,
  testsView,
  visibleLog,
} from './runModel';
import { TakeOverDialog } from './TakeOverDialog';

export type RunAction = 'pause' | 'resume' | 'take_over' | 'retry';

export interface RunViewProps {
  run: Run;
  /** Observed activity (work-supervision WS-13…WS-17), under the two columns and before the keys. */
  activity?: ReactNode;
  /** Log lines so far (the page shows the last 12). */
  log: readonly RunLogLine[];
  /** The agent's grants: "Neo’s keys for this run". */
  grants: readonly Grant[];
  /** The agent: its name and face (OA-08). */
  agent: { name: string; face?: AgentFace | null };
  /** Short name of whoever asked: "Mara". */
  askedBy: string;
  /** Where it was asked: "Chat". */
  where: string;
  timeZone: string;
  /** The signed-in person (paused / taken-over notices say "You"). */
  viewerId?: string | null;
  /** Short names for the notices ("Mara paused this run."). */
  nameOf?: (principalId: string) => string;
  /** "← Chat" target. */
  backHref: string;
  /** "Branch room" target; the button is hidden when the run has no PR. */
  branchRoomHref?: string | null;
  /** Client-side navigation for plain clicks on the links above. */
  onNavigate?: (href: string) => void;
  /** Pause, Resume, Try again, or Take over (after the confirm dialog). */
  onAction?: (action: RunAction) => void;
  /** An action in flight: its button is disabled until the server answers. */
  pending?: RunAction | null;
}

/**
 * Agent run page (README screen 5): header with the 96px avatar, kicker, title and controls; STEPS
 * timeline and LIVE LOG side by side (auto-fit, min 340px); keys for the run and files touched.
 */
export function RunView({
  run,
  log,
  grants,
  agent,
  askedBy,
  where,
  timeZone,
  viewerId = null,
  nameOf = (id) => id,
  backHref,
  branchRoomHref,
  onNavigate,
  onAction,
  pending = null,
  activity = null,
}: RunViewProps) {
  const titleId = useId();
  const [confirmTakeOver, setConfirmTakeOver] = useState(false);
  const dot = runDot(run.status);
  const controls = runControls(run.status);
  const notice = runNotice(run, { agent: agent.name, nameOf, viewerId, canRetry: controls.retry });
  const attention = runAttention(run);
  const tests = testsView(run.tests);
  const steps = stepViews(run, timeZone);
  const lines = visibleLog(log, timeZone, run.logCount);
  const keys = keyRows(grants);
  const kicker = runKicker(run, agent.name, timeZone);

  return (
    <section className={styles.screen} aria-labelledby={titleId} data-screen="run">
      <div className={styles.page}>
        <AppLink href={backHref} onNavigate={onNavigate} className={styles.back}>
          ← {where}
        </AppLink>

        <header className={styles.header}>
          <WhombatAvatar face={agentFaceOf(agent)} size={96} eager label={agent.name} />
          <div className={styles.heading}>
            <span className={styles.kicker} data-testid="run-kicker">
              <span
                aria-hidden="true"
                className={cx(styles.dot, dot.halo && styles.halo)}
                data-tone={dot.tone}
              />
              <span>{kicker[0]}</span>
              {kicker[1]}
            </span>
            <h1 id={titleId} className={styles.title}>
              {run.title}
            </h1>
            <span className={styles.sub}>
              Asked by <span className={styles.asker}>{askedBy}</span> in {where} · working in{' '}
              <span className={styles.branch}>{run.branch}</span>
            </span>
          </div>
          <div className={styles.actions}>
            {branchRoomHref && (
              <Button
                variant="secondary"
                size="lg"
                onClick={() =>
                  onNavigate ? onNavigate(branchRoomHref) : window.location.assign(branchRoomHref)
                }
              >
                Branch room
              </Button>
            )}
            {controls.toggle && (
              <Button
                variant="secondary"
                size="lg"
                disabled={pending !== null}
                aria-busy={pending === controls.toggle || undefined}
                onClick={() => controls.toggle && onAction?.(controls.toggle)}
              >
                {controls.toggle === 'pause' ? 'Pause' : 'Resume'}
              </Button>
            )}
            {controls.retry && (
              <Button
                variant="secondary"
                size="lg"
                disabled={pending !== null}
                aria-busy={pending === 'retry' || undefined}
                onClick={() => onAction?.('retry')}
              >
                Try again
              </Button>
            )}
            {controls.takeOver && (
              <Button
                variant="primary"
                size="lg"
                disabled={pending !== null}
                aria-busy={pending === 'take_over' || undefined}
                onClick={() => setConfirmTakeOver(true)}
              >
                Take over
              </Button>
            )}
          </div>
        </header>

        {notice && <Notice notice={notice} />}
        {attention && (
          <p className={styles.notice} data-tone="warn" data-testid="run-attention">
            <span className={styles.attentionLabel}>{RUN_ATTENTION_LABEL}</span> · {attention}
          </p>
        )}

        <div className={styles.columns}>
          <div className={styles.column}>
            <SectionLabel as="h2">STEPS</SectionLabel>
            <ol className={styles.steps} aria-label="Steps">
              {steps.map((s) => (
                <li key={s.key} className={styles.step} data-marker={s.marker}>
                  <div className={styles.rail} aria-hidden="true">
                    <span className={styles.marker} />
                    <span className={styles.connector} data-connector={s.connector} />
                  </div>
                  <div className={styles.stepText}>
                    <span className={styles.stepTitle}>
                      {s.title}
                      <span className={styles.srOnly}> · {s.stateLabel}</span>
                    </span>
                    <span className={styles.stepDetail}>{s.detail}</span>
                  </div>
                  <span className={styles.stepAt}>{s.at}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className={cx(styles.column, styles.logColumn)}>
            <div className={styles.logHead}>
              <SectionLabel as="h2">LIVE LOG</SectionLabel>
              {tests && (
                <span className={styles.tests} data-tone={tests.tone} data-testid="run-tests">
                  {tests.text}
                </span>
              )}
            </div>
            <div className={styles.log} role="log" aria-label="Live log" aria-live="polite">
              {lines.map((l) => (
                <div key={l.seq} className={styles.logLine}>
                  <span className={styles.logAt}>{l.at}</span>
                  <span className={styles.logText} data-tone={l.tone}>
                    {l.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {activity}

        <div className={styles.cards}>
          <Card
            title={runKeysTitle(agent.name, currentLocale())}
            meta={runKeysScope(run.branch, currentLocale())}
            metaClass={styles.scope}
          >
            <ul className={styles.keys}>
              {keys.map((k) => (
                <li key={k.keyId} className={styles.key}>
                  <span aria-hidden="true" className={styles.keyMark} data-tier={k.tier}>
                    {k.mark}
                  </span>
                  <span className={cx(styles.keyLabel, k.tier === 'cannot' && styles.keyLabelOff)}>
                    {k.label}
                    {k.tier === 'can' && <span className={styles.srOnly}> · can</span>}
                  </span>
                  <span className={styles.keyNote}>{k.note}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            title="Files touched"
            files
            meta={
              <>
                <span className={styles.add}>{formatAdditions(run.diff.add)}</span>{' '}
                <span className={styles.del}>{formatDeletions(run.diff.del)}</span>
              </>
            }
            metaClass={styles.stat}
          >
            <ul className={styles.files}>
              {run.files.map((f) => (
                <li key={f.path} className={styles.file}>
                  <span className={styles.path} title={f.path}>
                    {f.path}
                  </span>
                  <span>
                    <span className={styles.add}>{formatAdditions(f.add)}</span>{' '}
                    <span className={styles.del}>{formatDeletions(f.del)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <TakeOverDialog
        open={confirmTakeOver}
        onOpenChange={setConfirmTakeOver}
        agent={agent}
        branch={run.branch}
        onConfirm={() => {
          setConfirmTakeOver(false);
          onAction?.('take_over');
        }}
      />
    </section>
  );
}

function Notice({ notice }: { notice: RunNotice }) {
  return (
    <p className={styles.notice} data-tone={notice.tone} data-testid="run-notice">
      {notice.text}
      {notice.command && (
        <>
          {' '}
          <code className={styles.command}>{notice.command}</code>
        </>
      )}
    </p>
  );
}

function Card({
  title,
  meta,
  metaClass,
  files,
  children,
}: {
  title: string;
  meta: ReactNode;
  metaClass?: string;
  files?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx(styles.card, files && styles.filesCard)} aria-labelledby={id}>
      <div className={cx(styles.cardHead, files && styles.filesHead)}>
        <h2 id={id} className={styles.cardTitle}>
          {title}
        </h2>
        <span className={metaClass}>{meta}</span>
      </div>
      {children}
    </section>
  );
}

/** A real link that navigates client-side on plain clicks (new tab / window still work). */
function AppLink({
  href,
  onNavigate,
  className,
  children,
}: {
  href: string;
  onNavigate?: (href: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(href);
  };
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
