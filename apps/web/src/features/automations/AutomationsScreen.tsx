import {
  type AutomationListRow,
  type AutomationOverview,
  automationIdeas,
  automationListRows,
  automationOverview,
  problemText,
  SCHEDULE_TEXT,
  splitConfirm,
} from '@whombat/client';
import { useAgentSchedules, useHomeOverview, useScheduleAction, useTheAgent } from '@whombat/client/react';
import { type AgentScheduleView, formatClock, formatDate, scheduleCopy } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { writeProblem } from '../../app/problem';
import { useNavigateHref } from '../../app/routing/navigation';
import { LoadErrorNote } from '../../app/runtime';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { AskBox } from '../chats/AskBox';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { AutomationRow, ScheduleRow } from './AutomationRow';
import styles from './Automations.module.css';
import { listedSchedules, overviewWords } from './automationModel';
import { useAutomationNames, useAutomations } from './hooks';
import { useTalk } from './useAutomationActions';

export interface AutomationsScreenProps {
  burrow: string;
  /** `?new=1` (the sidebar's New automation): the field takes the focus, then the address forgets it. */
  asking?: boolean;
  onAsked?: () => void;
}

/** A phone's width, where the field's words are short so its buttons keep one row (as the composer's own media rule). */
const PHONE = '(max-width: 640px)';

const phoneQuery = () =>
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE) : null;

function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(() => phoneQuery()?.matches ?? false);
  useEffect(() => {
    const query = phoneQuery();
    if (!query) return;
    const change = () => setPhone(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return phone;
}

/** “11:22 on 23 Sep”: when the list on screen was read. */
function savedWhen(at: number, now: Date, timeZone: string): string {
  return `${formatClock(at, timeZone)} on ${formatDate(at, timeZone, { now })}`;
}

/**
 * Automations (docs/app/decisions/automation-chat.md, automation-page.md; docs/decisions/automations-final.md): an
 * overview of what the agent does on its own, not an editor. The field starts a Chat thread with the person's words,
 * which is how one is made or changed. Each automation is one compact row, opening its page; the agent's own schedules
 * follow under Only tells you with their switch and buttons. While it loads, rows without a count; with nothing yet,
 * what will show here; a list that didn't load says so, and one that didn't refresh stays with the time it was read.
 */
export function AutomationsScreen({ burrow, asking = false, onAsked }: AutomationsScreenProps) {
  const { data, error, isPending, refetch, isRefetching, dataUpdatedAt } = useAutomations({
    params: { burrow },
  });
  const { words } = useTheAgent(burrow);
  const page = overviewWords(words.name);
  const viewer = useBurrowViewer(burrow);
  const names = useAutomationNames(burrow);
  const navigate = useNavigateHref();
  const phone = usePhoneWidth();
  const askRef = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState<{ text: string; key: number } | null>(null);
  const now = new Date();
  const rows = useMemo(
    () => (data ? automationListRows(data.automations, new Date(), viewer.timeZone, names) : []),
    [data, viewer.timeZone, names],
  );
  const scheduleRead = useAgentSchedules({ params: { burrow } }, { retry: false });
  const schedules = listedSchedules(scheduleRead.data?.schedules);
  const overview = automationOverview(
    { pending: isPending, failed: !!error, count: data ? rows.length : null },
    {
      pending: scheduleRead.isPending,
      failed: !!scheduleRead.error,
      count: scheduleRead.data ? schedules.length : null,
    },
  );
  // Ideas from what is connected (care-plan.md): a server, mail, Home Assistant… then everyday ones.
  const { data: home } = useHomeOverview({ params: { burrow } }, { retry: false });
  const ideas = useMemo(() => automationIdeas(home?.things ?? []), [home?.things]);

  // The sidebar's New automation lands here with the field in focus; the address forgets it so a reload doesn't.
  useEffect(() => {
    if (asking) onAsked?.();
  }, [asking, onAsked]);

  const ask = () => setFill({ text: page.askText, key: Date.now() });
  const problem = error ? (
    <ReadProblem
      title={data ? page.refreshFailed : page.readFailed}
      text={data ? page.savedAt(savedWhen(dataUpdatedAt, now, viewer.timeZone)) : page.readFailedText}
      detail={problemText(error)}
      words={page}
      busy={isRefetching}
      onRetry={() => void refetch()}
      onAsk={ask}
    />
  ) : null;

  return (
    <div className={styles.scroll} data-screen="automations">
      <div className={cx(styles.page, styles.listPage)}>
        <div className={styles.listTop}>
          <h1 className={styles.listTitle}>{page.title}</h1>
          <p className={styles.listSubtitle}>{page.subtitle}</p>
        </div>
        {problem}
        <p className={styles.askIntro} id="automations-ask-intro">
          {page.intro}
        </p>
        <div ref={askRef}>
          <AskBox
            burrow={burrow}
            placeholder={phone ? page.placeholderShort : page.placeholder}
            suggestions={ideas}
            autoFocus={asking}
            fill={fill}
            className={styles.ask}
          />
        </div>
        {overview.body === 'loading' ? (
          <section className={styles.section} aria-busy="true" aria-label={page.loading}>
            <p className={styles.loadingWords}>{page.loading}</p>
            <SkeletonRows count={8} lines={2} />
          </section>
        ) : overview.body === 'unread' ? null : (
          <OverviewList
            burrow={burrow}
            rows={rows}
            schedules={schedules}
            overview={overview}
            schedulesError={scheduleRead.error}
            onRetrySchedules={() => void scheduleRead.refetch()}
            agentName={words.name}
            page={page}
            timeZone={viewer.timeZone}
            now={now}
            onOpen={navigate}
            onTell={() => askRef.current?.querySelector('textarea')?.focus()}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The list didn't load, or didn't refresh: what happened and what is on screen, Try again (it only reads the list again),
 * Ask Neo (the question in the field, unsent) and the error folded under More detail.
 */
function ReadProblem({
  title,
  text,
  detail,
  words,
  busy,
  onRetry,
  onAsk,
}: {
  title: string;
  text: string;
  detail: string;
  words: ReturnType<typeof overviewWords>;
  busy: boolean;
  onRetry: () => void;
  onAsk: () => void;
}) {
  return (
    <section className={styles.readError} role="alert" data-automations-problem="">
      <h2 className={styles.readErrorTitle}>{title}</h2>
      <p className={styles.readErrorText}>{text}</p>
      <div className={styles.readErrorActions}>
        <Button variant="primary" size="md" className={styles.target} disabled={busy} onClick={onRetry}>
          {words.tryAgain}
        </Button>
        <Button variant="secondary" size="md" className={styles.target} onClick={onAsk}>
          {words.ask}
        </Button>
      </div>
      <details className={styles.readErrorDetail}>
        <summary>{words.moreDetail}</summary>
        <p className={styles.readErrorText}>{detail}</p>
      </details>
    </section>
  );
}

/**
 * The automations, then the agent's schedules (`schedules.list`) under Only tells you, each group a card; the
 * schedules' switch is Pause and Resume, Remove asks first. Schedules that didn't load say so there, with Retry, over
 * the rows already read.
 */
function OverviewList({
  burrow,
  rows,
  schedules,
  overview,
  schedulesError,
  onRetrySchedules,
  agentName,
  page,
  timeZone,
  now,
  onOpen,
  onTell,
}: {
  burrow: string;
  rows: readonly AutomationListRow[];
  schedules: readonly AgentScheduleView[];
  overview: AutomationOverview;
  schedulesError: unknown;
  onRetrySchedules: () => void;
  agentName: string;
  page: ReturnType<typeof overviewWords>;
  timeZone: string;
  now: Date;
  onOpen: (href: string) => void;
  /** Nothing yet: “Tell Neo…” puts the focus in the field. */
  onTell: () => void;
}) {
  const toast = useToast();
  const talk = useTalk(burrow);
  const pause = useScheduleAction(api.schedules.pause);
  const resume = useScheduleAction(api.schedules.resume);
  const remove = useScheduleAction(api.schedules.remove);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AgentScheduleView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const copy = scheduleCopy(agentName);
  const confirm = splitConfirm(copy.removeConfirm);

  async function act(action: 'pause' | 'resume' | 'remove', s: AgentScheduleView): Promise<boolean> {
    const mutation = action === 'pause' ? pause : action === 'resume' ? resume : remove;
    setBusy(s.id);
    setProblem(null);
    try {
      const result = await mutation.mutateAsync({ params: { burrow, scheduleId: s.id } });
      if (result.status !== 'ok') {
        const words = result.status === 'blocked' ? result.message : SCHEDULE_TEXT.failed;
        if (action === 'remove') setProblem(words);
        else toast.show(words);
        return false;
      }
      toast.show(
        action === 'pause'
          ? SCHEDULE_TEXT.paused
          : action === 'resume'
            ? SCHEDULE_TEXT.resumed
            : copy.cancelled,
      );
      return true;
    } catch (e) {
      if (action === 'remove') setProblem(writeProblem(e));
      else toast.show(writeProblem(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (overview.body === 'empty')
    return (
      <section className={styles.emptyState} aria-labelledby="automations-empty">
        <span className={styles.emptyIcon} aria-hidden="true">
          <Icon icon={Zap} size={22} />
        </span>
        <h2 className={styles.emptyTitle} id="automations-empty">
          {page.emptyTitle}
        </h2>
        <p className={styles.emptyText}>{page.empty}</p>
        <Button variant="primary" size="md" className={styles.target} onClick={onTell}>
          {page.emptyButton}
        </Button>
      </section>
    );
  return (
    <>
      {rows.length ? (
        <section className={styles.section} aria-labelledby="automations-list">
          <h2 className={styles.groupTitle} id="automations-list">
            {page.automations} <span className={styles.groupCount}>{rows.length}</span>
          </h2>
          <div className={styles.card}>
            {rows.map((row) => (
              <AutomationRow key={row.id} burrow={burrow} row={row} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ) : null}
      {overview.schedules !== 'hidden' ? (
        <section className={styles.section} aria-labelledby="automations-only-tells">
          <h2 className={styles.groupTitle} id="automations-only-tells">
            {page.onlyTellsYou}
          </h2>
          {overview.schedules === 'failed' ? (
            <LoadErrorNote
              error={schedulesError}
              message={SCHEDULE_TEXT.loadFailed}
              onRetry={onRetrySchedules}
              className={styles.schedulesProblem}
            />
          ) : null}
          {schedules.length ? (
            <div className={styles.card}>
              {schedules.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  timeZone={timeZone}
                  now={now}
                  busy={busy === s.id}
                  onSwitch={(on) => void act(on ? 'resume' : 'pause', s)}
                  onRemove={() => {
                    setProblem(null);
                    setConfirming(s);
                  }}
                  onTalk={
                    s.threadRootId
                      ? () =>
                          talk.go({
                            conversationId: s.conversationId,
                            threadRootId: s.threadRootId as string,
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      <Modal open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <ModalTitle className={styles.confirmTitle}>{confirm.title}</ModalTitle>
        <ModalDescription className={styles.confirmText}>{confirm.text}</ModalDescription>
        {problem && (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        )}
        <div className={styles.modalActions}>
          <Button variant="secondary" size="xl" onClick={() => setConfirming(null)}>
            {copy.cancel}
          </Button>
          <Button
            variant="primary"
            size="xl"
            className={styles.dangerPrimary}
            disabled={remove.isPending}
            onClick={async () => {
              if (confirming && (await act('remove', confirming))) setConfirming(null);
            }}
          >
            {copy.remove}
          </Button>
        </div>
      </Modal>
    </>
  );
}
