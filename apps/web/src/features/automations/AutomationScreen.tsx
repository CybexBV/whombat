import {
  AUTOMATION_PAGE_TEXT,
  AUTOMATION_WAITING_TEXT,
  type AutomationPageView,
  automationPage,
  automationRunRows,
  NeedsNewerAppError,
  type RunBarTone,
  runBars,
  SCREEN_NEEDS_NEWER_APP,
} from '@whombat/client';
import { useTheAgent } from '@whombat/client/react';
import type {
  AutomationDetail,
  AutomationFlowIcon,
  AutomationFlowItem,
  AutomationPlanLine,
} from '@whombat/core';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  GitMerge,
  GitPullRequest,
  Hand,
  Link,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Play,
  Power,
  Reply,
  Zap,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { ScreenPlaceholder } from '../../components/Placeholder';
import { SectionLabel } from '../../components/SectionLabel';
import { Toggle } from '../../components/Toggle';
import { PrincipalAvatar } from '../messaging/PrincipalAvatar';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { follow, RunBars, StateDot } from './AutomationRow';
import styles from './Automations.module.css';
import { DeleteAutomationDialog, type DeleteTarget } from './DeleteAutomationDialog';
import { automationPaths, useAutomation, useAutomationNames, useAutomationRuns } from './hooks';
import { SourceTile } from './SourceTile';
import { useStartRun, useSwitch, useTalk } from './useAutomationActions';

export interface AutomationScreenProps {
  burrow: string;
  id: string;
}

/**
 * One automation (docs/app/decisions/automation-page.md AP-6331…AP-6335, AP-6381), read-only, as the phone shows it:
 * its tile and whole name; On or Off with the switch, or what waits for the person; the agent's sentence of what it is
 * for; Try it (or Run now) and Talk about it; what happens step by step (core `automationFlow`); what it asks first, its
 * limits and its recent runs; what the agent is asked, folded; Delete. It changes only by talking to the agent.
 */
export function AutomationScreen({ burrow, id }: AutomationScreenProps) {
  const { data, error, isPending, refetch } = useAutomation({ params: { burrow, id } });
  const navigate = useNavigateHref();
  if (!data) {
    if (isPending)
      return (
        <section className={styles.scroll} aria-busy="true">
          <div className={styles.page}>
            <SkeletonRows count={5} lines={2} />
          </div>
        </section>
      );
    const notFound = error && 'status' in error && error.status === 404;
    return (
      <ScreenPlaceholder
        screen="automation"
        title="Automation"
        subtitle={
          notFound
            ? 'This automation doesn’t exist, or it was deleted.'
            : error instanceof NeedsNewerAppError
              ? SCREEN_NEEDS_NEWER_APP
              : 'Couldn’t load this automation. Try again in a moment.'
        }
      >
        {notFound ? (
          <Button variant="secondary" size="sm" onClick={() => navigate(automationPaths.list())}>
            All automations
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (error instanceof NeedsNewerAppError ? window.location.reload() : void refetch())}
          >
            {error instanceof NeedsNewerAppError ? 'Reload' : 'Retry'}
          </Button>
        )}
      </ScreenPlaceholder>
    );
  }
  return <AutomationPage key={data.automation.id} burrow={burrow} detail={data} />;
}

function AutomationPage({ burrow, detail }: { burrow: string; detail: AutomationDetail }) {
  const { automation } = detail;
  const navigate = useNavigateHref();
  const viewer = useBurrowViewer(burrow);
  const names = useAutomationNames(burrow);
  const { agent } = useTheAgent(burrow);
  const switching = useSwitch(burrow);
  const start = useStartRun(burrow);
  const talk = useTalk(burrow);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const page = automationPage(automation, { now: new Date(), timeZone: viewer.timeZone, names });
  // Deleted from this page: its own `automation.deleted` frame can land before the answer, which then never reaches
  // the dialog (it closes with the page's deleted state), so the page goes back to the list itself.
  useEffect(() => {
    if (automation.deletedAt && deleting?.id === automation.id) navigate(automationPaths.list());
  }, [automation.deletedAt, automation.id, deleting, navigate]);

  const head = (
    <>
      <div className={styles.kicker}>
        <a
          className={styles.back}
          href={automationPaths.list()}
          onClick={follow(navigate, automationPaths.list())}
        >
          AUTOMATIONS
        </a>
      </div>
      <div className={styles.pageHead}>
        <SourceTile burrow={burrow} tile={page.tile} size="page" />
        <h1 className={styles.pageTitle}>{page.name}</h1>
      </div>
    </>
  );

  // Deleted while open (the `automation.deleted` frame, AP-972): what it was, and nothing to change.
  if (automation.deletedAt)
    return (
      <div className={styles.scroll} data-screen="automation">
        <div className={cx(styles.page, styles.pageContainer)}>
          {head}
          <p className={styles.note}>This automation was deleted.</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => navigate(automationPaths.list())}>
              All automations
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <div className={styles.scroll} data-screen="automation">
      <div className={cx(styles.page, styles.pageContainer)}>
        {head}
        <div className={styles.pageGrid}>
          <StateCard
            page={page}
            switching={switching.busy === automation.id}
            onSwitch={(on) => switching.set(automation, on)}
            onTalk={() => talk.open(automation)}
            onOpen={navigate}
          />
          <div className={styles.pageMain}>
            {page.description ? <p className={styles.description}>{page.description}</p> : null}
            <div className={styles.actions}>
              {page.run ? (
                <Button
                  variant="primary"
                  iconStart={<Icon icon={Play} size={15} />}
                  title={page.run.hint}
                  disabled={start.busy !== null}
                  onClick={() => {
                    if (page.run?.kind === 'run') void start.runNow(automation.id);
                    else if (page.run) void start.tryIt(automation.id, page.run.tryIt);
                  }}
                >
                  {page.run.label}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                iconStart={<Icon icon={MessageCircle} size={15} />}
                title={page.talkHint}
                onClick={() => talk.open(automation)}
              >
                Talk about it
              </Button>
            </div>
            <section className={styles.section} aria-labelledby="automation-happens">
              <SectionLabel as="h2" id="automation-happens">
                {AUTOMATION_PAGE_TEXT.whatHappens}
              </SectionLabel>
              {page.flow ? (
                <Flow items={page.flow} agent={agent} />
              ) : (
                <p className={styles.description}>{page.summary}</p>
              )}
            </section>
            {page.prompts.length ? (
              <details className={cx(styles.card, styles.prompts)} data-automation-prompts="">
                <summary className={styles.promptsHead}>
                  <span className={styles.promptsTitle}>{AUTOMATION_PAGE_TEXT.prompts(names.agent)}</span>
                  <span className={styles.promptsCount}>
                    {AUTOMATION_PAGE_TEXT.promptsCount(page.prompts.length)}
                  </span>
                  <Icon icon={ChevronDown} size={16} className={styles.promptsChevron} />
                </summary>
                {page.prompts.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps may share a name
                  <div key={i} className={styles.prompt}>
                    <span className={styles.promptStep}>{p.step}</span>
                    <p className={styles.promptText}>{p.text}</p>
                  </div>
                ))}
              </details>
            ) : null}
          </div>
          <div className={styles.pageSide}>
            {page.asks.length ? (
              <Lines id="automation-asks" title={AUTOMATION_PAGE_TEXT.asks} lines={page.asks} />
            ) : null}
            {page.limits.length ? (
              <Lines id="automation-limits" title={AUTOMATION_PAGE_TEXT.limits} lines={page.limits} />
            ) : null}
            <RecentRuns burrow={burrow} automationId={automation.id} timeZone={viewer.timeZone} />
            <button
              type="button"
              className={styles.deleteButton}
              onClick={() => setDeleting({ id: automation.id, name: automation.name })}
            >
              {AUTOMATION_PAGE_TEXT.delete}
            </button>
          </div>
        </div>
      </div>
      <DeleteAutomationDialog
        burrow={burrow}
        target={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => navigate(automationPaths.list())}
      />
    </div>
  );
}

/**
 * Whether it runs: a dot with On, Off or Not on yet and the switch, then its last run and its next in words (“Last run
 * worked · 23 Sep, 11:06”, “Next run on a new issue”); when something waits for the person, what it is and Open (the
 * run, else the plan's thread). A run that failed is something that happened: the automation still says On.
 */
function StateCard({
  page,
  switching,
  onSwitch,
  onTalk,
  onOpen,
}: {
  page: AutomationPageView;
  switching: boolean;
  onSwitch: (on: boolean) => void;
  onTalk: () => void;
  onOpen: (href: string) => void;
}) {
  const switchId = useId();
  const { state } = page;
  const waiting = state.tone === 'waiting';
  // One stop for a screen reader: “Run #49 is waiting for a yes. Open”.
  const waitingLabel = `${state.line.replace(/[.!?…]?$/, '.')} ${AUTOMATION_WAITING_TEXT.open}`;
  const waitingBody = (
    <>
      <i className={cx(styles.stateDot, styles.dotWaiting)} aria-hidden="true" />
      <span className={styles.waitingText}>{state.line}</span>
      <span className={styles.waitingOpen}>{AUTOMATION_WAITING_TEXT.open}</span>
    </>
  );
  // What it did and does next; one never on, or off without a run, says that in its own words.
  const lines =
    state.runs === 'on'
      ? [state.last, state.next]
      : state.runs === 'off'
        ? [state.line === state.last ? state.last : state.line]
        : waiting
          ? []
          : [state.line];
  return (
    <div className={cx(styles.card, styles.stateCard)} data-automation-state={state.tone}>
      <div className={styles.stateTop}>
        <div className={styles.stateWords}>
          <span className={styles.stateHead}>
            <StateDot tone={state.runs} />
            <label htmlFor={page.switch ? switchId : undefined}>{state.label}</label>
          </span>
          {lines.map((l) =>
            l ? (
              <span key={l} className={styles.stateSub}>
                {l}
              </span>
            ) : null,
          )}
        </div>
        {page.switch ? (
          <Toggle
            id={switchId}
            checked={page.switch.on}
            disabled={switching}
            onCheckedChange={onSwitch}
            aria-label={page.name}
          />
        ) : null}
      </div>
      {waiting ? (
        state.waitingRun ? (
          <a
            className={styles.waitingLine}
            href={automationPaths.run(state.waitingRun)}
            onClick={follow(onOpen, automationPaths.run(state.waitingRun))}
            aria-label={waitingLabel}
            data-waiting=""
          >
            {waitingBody}
          </a>
        ) : (
          <button
            type="button"
            className={styles.waitingLine}
            onClick={onTalk}
            aria-label={waitingLabel}
            data-waiting=""
          >
            {waitingBody}
          </button>
        )
      ) : null}
    </div>
  );
}

/** A section of plain lines (ASKS YOU FIRST, LIMITS): each line, its detail quieter under it. */
function Lines({ id, title, lines }: { id: string; title: string; lines: readonly AutomationPlanLine[] }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <SectionLabel as="h2" id={id}>
        {title}
      </SectionLabel>
      <ul className={cx(styles.card, styles.lines)}>
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same; their order is their identity
          <li key={i} className={styles.line}>
            {l.text}
            {l.detail ? <span className={styles.lineDetail}>{l.detail}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const RUN_DOT: Record<RunBarTone, string | undefined> = {
  ok: styles.barOk,
  bad: styles.barBad,
  warn: styles.barWarn,
  brand: styles.barBrand,
  quiet: styles.runDotQuiet,
};

/** Its last ten runs, newest first, each opening the run; nothing before the first. */
function RecentRuns({
  burrow,
  automationId,
  timeZone,
}: {
  burrow: string;
  automationId: string;
  timeZone: string;
}) {
  const { data, error, isPending, refetch } = useAutomationRuns({
    params: { burrow },
    query: { automation: automationId, limit: 10 },
  });
  const navigate = useNavigateHref();
  if (isPending) return <SkeletonRows count={2} lines={1} />;
  if (error) return <ErrorNote message="Couldn’t load the runs." onRetry={() => void refetch()} />;
  const rows = automationRunRows(data.runs, new Date(), timeZone);
  if (!rows.length) return null;
  // The last few as small bars, oldest left; each run below says its result in words.
  const { bars } = runBars(data.runs);
  return (
    <section className={styles.section} aria-labelledby="automation-runs">
      <span className={styles.runsHead}>
        <SectionLabel as="h2" id="automation-runs">
          {AUTOMATION_PAGE_TEXT.runs}
        </SectionLabel>
        <RunBars bars={bars} />
      </span>
      <div className={styles.card}>
        {rows.map((r) => {
          const href = automationPaths.run(r.number);
          return (
            <a
              key={r.number}
              className={styles.runRow}
              href={href}
              onClick={follow(navigate, href)}
              aria-label={r.accessibilityLabel}
            >
              <i className={cx(styles.runDot, RUN_DOT[r.tone])} aria-hidden="true" />
              <span className={styles.runWords}>
                <span className={styles.runTitle}>{r.title}</span>
                <span className={styles.runWhen}>
                  {r.result} · {r.when}
                </span>
              </span>
              <Icon icon={ChevronRight} size={16} className={styles.listChevron} />
            </a>
          );
        })}
      </div>
    </section>
  );
}

const FLOW_ICONS: Record<Exclude<AutomationFlowIcon, 'agent'>, LucideIcon> = {
  start: Zap,
  post: MessageSquare,
  ask: Hand,
  wait: Clock,
  pull_request: GitPullRequest,
  merge: GitMerge,
  comment: MessageCircle,
  report: FileText,
  reply: Reply,
  call: Link,
  act: Power,
};

const MARK = { plain: undefined, changes: styles.markChanges, merges: styles.markMerges } as const;

/**
 * What happens, step by step (AP-6332): a rail of round marks joined by a line — what starts it filled, the agent's
 * steps its picture — each step's title, its details and its marks; a check between steps is a dashed stretch of the
 * rail with its question and what a no does, in italics.
 */
function Flow({
  items,
  agent,
}: {
  items: readonly AutomationFlowItem[];
  agent: ReturnType<typeof useTheAgent>['agent'];
}) {
  return (
    <ol className={styles.flow}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        if (item.kind === 'gate')
          return (
            <li key={item.id} className={styles.flowItem} data-flow-gate="">
              <span className={styles.flowRail} aria-hidden="true">
                <i className={styles.flowDash} />
              </span>
              <p className={styles.flowGate}>{item.text}</p>
            </li>
          );
        const when = item.kind === 'when';
        return (
          <li
            key={when ? 'when' : item.id}
            className={styles.flowItem}
            data-flow-step={when ? 'when' : item.icon}
          >
            <span className={styles.flowRail} aria-hidden="true">
              <span className={cx(styles.flowMark, when && styles.flowMarkWhen)}>
                {when ? (
                  <Icon icon={Zap} size={15} />
                ) : item.icon === 'agent' ? (
                  <PrincipalAvatar principal={agent} size={26} crop="head" />
                ) : (
                  <Icon icon={FLOW_ICONS[item.icon]} size={15} />
                )}
              </span>
              {last ? null : <i className={styles.flowLine} />}
            </span>
            <div className={styles.flowBody}>
              <p className={styles.flowTitle}>{when ? item.text : item.title}</p>
              {item.details.map((d) => (
                <p key={d} className={styles.flowDetail}>
                  {d}
                </p>
              ))}
              {!when && item.marks.length ? (
                <ul className={styles.flowMarks}>
                  {item.marks.map((m) => (
                    <li key={m.label} className={cx(styles.flowTag, MARK[m.tone])}>
                      <Icon icon={ArrowUpRight} size={12} />
                      {m.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
