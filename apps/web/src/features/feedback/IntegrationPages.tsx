import { useQueryClient } from '@tanstack/react-query';
import { createLink, useBlocker, useNavigate } from '@tanstack/react-router';
import { ApiError } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useBootstrap, useFeedbackIntegration, useFeedbackIntegrations } from '@whombat/client/react';
import { api, type FeedbackIntegrationDetail } from '@whombat/core/contracts';
import type { FeedbackIntegration } from '@whombat/core/domain';
import { formatDate } from '@whombat/core/text';
import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import settings from '../settings/SettingsScreen.module.css';
import { FEEDBACK_TEXT, lastChangedLine, stepCounter } from './copy';
import styles from './Feedback.module.css';
import {
  IntegrationHealth,
  IntegrationSnippets,
  IntegrationStatus,
  TestReport,
  useDelivery,
} from './IntegrationDetail';
import {
  type IntegrationFormState,
  PrivacyFields,
  ReportsFields,
  SiteFields,
  useIntegrationForm,
  WidgetFields,
} from './IntegrationForm';
import page from './IntegrationPages.module.css';
import {
  hasAdvancedErrors,
  SETTINGS_STEPS,
  type SettingsStep,
  STEPS,
  type StepKey,
  stepIndex,
} from './steps';

const RouterButtonLink = createLink(ButtonLink);

/* Page frame -------------------------------------------------------------------------------------- */

function BackLink() {
  return (
    <RouterButtonLink
      variant="link"
      to="/settings"
      search={{ tab: 'connections', connection: 'feedback' }}
      className={page.back}
    >
      {FEEDBACK_TEXT.back}
    </RouterButtonLink>
  );
}

function Frame({
  title,
  meta,
  children,
  bar,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  /** The sticky action bar at the bottom of the page. */
  bar?: ReactNode;
}) {
  return (
    <div className={page.scroll} data-screen="feedback-integration">
      <div className={page.page}>
        <BackLink />
        <header className={page.header}>
          <SectionLabel>{FEEDBACK_TEXT.kicker}</SectionLabel>
          <h1 className={page.title}>{title}</h1>
          {meta && <span className={styles.mono}>{meta}</span>}
        </header>
        {children}
        {bar}
      </div>
    </div>
  );
}

/** Integrations the server says can't be managed here (`can.manage`, or its 403): the list's words, on the page. */
function Locked({ title }: { title: string }) {
  return (
    <Frame title={title}>
      <div className={settings.card}>
        <p className={settings.empty}>{FEEDBACK_TEXT.locked}</p>
      </div>
    </Frame>
  );
}

function Loading({ title }: { title: string }) {
  return (
    <Frame title={title}>
      <div className={settings.card} aria-busy="true">
        <SkeletonRows count={3} lines={2} />
      </div>
    </Frame>
  );
}

/**
 * Asks before leaving a page with unsaved changes (another page, a reload, closing the tab). Moving between the
 * stepper's steps stays on the page and never asks.
 */
function useLeaveGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!dirtyRef.current || current.pathname === next.pathname) return false;
      return !window.confirm(FEEDBACK_TEXT.leaveConfirm);
    },
    enableBeforeUnload: () => dirtyRef.current,
  });
  /** Call before navigating away on purpose (after a save). */
  return () => {
    dirtyRef.current = false;
  };
}

/**
 * Moves focus to the first field with a problem, once it has rendered, unless the person has moved focus since: someone
 * already typing into a field must not have the rest of their typing land in another one (the frame can come late).
 */
function focusFirstInvalid(root: HTMLElement | null) {
  const before = document.activeElement;
  requestAnimationFrame(() => {
    if (document.activeElement !== before) return;
    root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });
}

/* Stepper ----------------------------------------------------------------------------------------- */

function Stepper({
  current,
  reachable,
  onGo,
}: {
  current: StepKey;
  /** Steps a click may go to (earlier ones, and later ones whose earlier steps are fine). */
  reachable: (step: StepKey) => boolean;
  onGo?: (step: SettingsStep) => void;
}) {
  const at = stepIndex(current);
  return (
    <nav aria-label={FEEDBACK_TEXT.steps} className={page.stepperNav}>
      <ol className={page.stepper}>
        {STEPS.map((s, i) => {
          const done = i < at;
          const here = i === at;
          const inner = (
            <>
              <span
                className={page.srOnly}
              >{`${stepCounter(i + 1, STEPS.length)}${done ? ', done' : ''}: `}</span>
              <span
                aria-hidden="true"
                className={page.stepDot}
                data-done={done || undefined}
                data-current={here || undefined}
              >
                {done ? <Icon icon={Check} size={14} /> : i + 1}
              </span>
              <span className={page.stepText}>
                <span className={page.stepTitle}>{s.title}</span>
                <span className={page.stepHint}>{s.hint}</span>
              </span>
            </>
          );
          const go = s.key !== 'install' && !here && onGo && reachable(s.key);
          return (
            <li key={s.key} className={page.stepItem} data-current={here || undefined}>
              {go ? (
                <button type="button" className={page.step} onClick={() => onGo(s.key as SettingsStep)}>
                  {inner}
                </button>
              ) : (
                <span className={page.step} aria-current={here ? 'step' : undefined}>
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A step's or section's heading: “Step 2 of 4” over the title in the stepper, the title alone when editing. */
function PanelHead({
  id,
  title,
  hint,
  counter,
  focusRef,
}: {
  id: string;
  title: string;
  hint?: string;
  counter?: string;
  focusRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className={page.panelHead}>
      {counter && <SectionLabel>{counter}</SectionLabel>}
      <h2 id={id} className={page.panelTitle} ref={focusRef} tabIndex={focusRef ? -1 : undefined}>
        {title}
      </h2>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

/** “Privacy and limits”: collapsed until opened, or while one of its fields has a problem. */
function Advanced({ f }: { f: IntegrationFormState }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = open || hasAdvancedErrors(f.errors);
  return (
    <div className={page.advanced}>
      <button
        type="button"
        className={page.advancedToggle}
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setOpen(!shown)}
      >
        <Icon icon={ChevronDown} size={16} className={page.chevron} data-open={shown || undefined} />
        <span className={page.advancedText}>
          <span className={page.advancedTitle}>{FEEDBACK_TEXT.advanced}</span>
          <span className={styles.hint}>{FEEDBACK_TEXT.advancedHint}</span>
        </span>
      </button>
      <div id={id} className={page.advancedBody} hidden={!shown}>
        {shown && <PrivacyFields f={f} />}
      </div>
    </div>
  );
}

function ProblemNote({ problem }: { problem: string | null }) {
  return problem ? (
    <p className={styles.footerNote} role="alert">
      {problem}
    </p>
  ) : null;
}

/* New integration --------------------------------------------------------------------------------- */

export interface NewIntegrationPageProps {
  burrow: string;
  /** The step shown (`?step=`). */
  step: SettingsStep;
  /** Goes to another step (pushes `?step=`, so Back in the browser goes back a step). */
  onStepChange: (step: SettingsStep, options?: { replace?: boolean }) => void;
}

/**
 * New integration (docs/decisions/ui-improvements.md AP-400…AP-409): a page in four steps. 1. Name & site,
 * 2. Where reports go, 3. Widget (with Privacy and limits), then Create; 4. Install is the integration's own page
 * (`?step=install`), since snippets and health exist only once the server made it. Each Next checks its step with the
 * server's schema; a refused Create goes back to the first step the server named.
 */
export function FeedbackNewIntegrationPage({ burrow, step, onStepChange }: NewIntegrationPageProps) {
  const list = useFeedbackIntegrations({ params: { burrow } });
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  if (forbidden || (list.data && !list.data.can.manage))
    return <Locked title={FEEDBACK_TEXT.newIntegration} />;
  if (list.error && !list.data)
    return (
      <Frame title={FEEDBACK_TEXT.newIntegration}>
        <ErrorNote message={FEEDBACK_TEXT.loadFailed} onRetry={() => void list.refetch()} />
      </Frame>
    );
  if (!list.data) return <Loading title={FEEDBACK_TEXT.newIntegration} />;
  return <NewIntegrationSteps burrow={burrow} step={step} onStepChange={onStepChange} />;
}

function NewIntegrationSteps({ burrow, step, onStepChange }: NewIntegrationPageProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ids = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const release = useRef<() => void>(() => {});

  const f = useIntegrationForm({
    burrow,
    integration: null,
    onConflict: async () => null,
    onSaved: (integration) => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.listIntegrations) });
      toast.show(`${integration.name} created.`);
      release.current();
      void navigate({
        to: '/settings/feedback/$id',
        params: { id: integration.id },
        search: { step: 'install' },
        replace: true,
      });
    },
  });
  release.current = useLeaveGuard(f.dirty);

  const at = Math.max(0, stepIndex(step));
  const valid = (s: SettingsStep) => f.problemsIn([s]) === 0;
  // A step can be reached when every step before it is fine (a reload on ?step=widget starts at the first gap).
  const reachable = (target: StepKey) => {
    const index = stepIndex(target);
    return (
      index >= 0 && STEPS.slice(0, index).every((s) => s.key === 'install' || valid(s.key as SettingsStep))
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens on a step; later, Next and the stepper check before they move
  useEffect(() => {
    if (!reachable(step)) {
      const gap = SETTINGS_STEPS.find((s) => !valid(s)) ?? SETTINGS_STEPS[0];
      if (gap && gap !== step) onStepChange(gap, { replace: true });
    }
  }, []);

  // A new step starts at its top, its heading focused (not when the page opens).
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.closest(`.${page.scroll}`)?.scrollTo?.({ top: 0 });
  }, [step]);

  function go(target: SettingsStep) {
    if (stepIndex(target) > at) {
      const bad = f.check(STEPS.slice(at, stepIndex(target)).map((s) => s.key as SettingsStep));
      if (Object.keys(bad).length) {
        focusFirstInvalid(formRef.current);
        return;
      }
    }
    onStepChange(target);
  }

  async function create() {
    const result = await f.submit();
    if (result.ok) return;
    if (result.step && result.step !== step) onStepChange(result.step);
    focusFirstInvalid(formRef.current);
  }

  const meta = STEPS[at];
  const last = step === SETTINGS_STEPS[SETTINGS_STEPS.length - 1];
  return (
    <Frame
      title={FEEDBACK_TEXT.newIntegration}
      bar={
        <div className={page.bar}>
          <ProblemNote problem={f.problem} />
          <div className={page.barActions}>
            {at === 0 ? (
              <RouterButtonLink
                variant="secondary"
                size="md"
                to="/settings"
                search={{ tab: 'connections', connection: 'feedback' }}
              >
                {FEEDBACK_TEXT.cancel}
              </RouterButtonLink>
            ) : (
              <Button
                variant="secondary"
                size="md"
                onClick={() => onStepChange(STEPS[at - 1]?.key as SettingsStep)}
              >
                {FEEDBACK_TEXT.previous}
              </Button>
            )}
            <Button type="submit" form={`${ids}-form`} variant="primary" size="md" disabled={f.busy}>
              {last ? FEEDBACK_TEXT.create : FEEDBACK_TEXT.next}
            </Button>
          </div>
        </div>
      }
    >
      <Stepper current={meta?.key ?? step} reachable={reachable} onGo={go} />
      <form
        id={`${ids}-form`}
        ref={formRef}
        className={page.panel}
        onSubmit={(e) => {
          e.preventDefault();
          if (last) void create();
          else go(STEPS[at + 1]?.key as SettingsStep);
        }}
        noValidate
        aria-labelledby={`${ids}-title`}
      >
        <PanelHead
          id={`${ids}-title`}
          title={meta?.title ?? ''}
          counter={stepCounter(at + 1, STEPS.length)}
          focusRef={headingRef}
        />
        <div className={styles.form}>
          {meta?.key === 'site' ? (
            <SiteFields f={f} />
          ) : meta?.key === 'reports' ? (
            <ReportsFields f={f} />
          ) : (
            <>
              <WidgetFields f={f} />
              <Advanced f={f} />
            </>
          )}
        </div>
      </form>
    </Frame>
  );
}

/* An integration ---------------------------------------------------------------------------------- */

export interface IntegrationPageProps {
  burrow: string;
  id: string;
  /** Right after Create: the stepper's Install step instead of the edit page (`?step=install`). */
  setup: boolean;
}

/**
 * An integration's page: right after Create the stepper's Install step (snippets, a test report, the switches and
 * health), otherwise the edit page — the same sections without the stepper, a save bar at the bottom.
 */
export function FeedbackIntegrationPage({ burrow, id, setup }: IntegrationPageProps) {
  const detail = useFeedbackIntegration({ params: { burrow, id } });
  const data = detail.data;
  const title = data?.integration.name ?? 'Integration';
  const forbidden = detail.error instanceof ApiError && detail.error.status === 403;
  if (forbidden || (data && !data.can.manage)) return <Locked title={title} />;
  if (detail.error && !data)
    return (
      <Frame title={title}>
        <ErrorNote
          message={
            detail.error instanceof ApiError && detail.error.status === 404
              ? FEEDBACK_TEXT.notFound
              : FEEDBACK_TEXT.loadOneFailed
          }
          onRetry={() => void detail.refetch()}
        />
      </Frame>
    );
  if (!data) return <Loading title={title} />;
  const check = () => void detail.refetch();
  return setup ? (
    <InstallStep burrow={burrow} detail={data} onCheck={check} checking={detail.isFetching} />
  ) : (
    <EditIntegration
      burrow={burrow}
      detail={data}
      onCheck={check}
      checking={detail.isFetching}
      reload={async () => (await detail.refetch()).data?.integration ?? null}
    />
  );
}

function metaOf(i: FeedbackIntegration) {
  return `${i.siteId} · ${i.productLabel}`;
}

interface DetailPageProps {
  burrow: string;
  detail: FeedbackIntegrationDetail;
  onCheck: () => void;
  checking: boolean;
}

/** INSTALL (the snippets) and SEND A TEST REPORT: the stepper's last step, and the end of the edit page. */
function InstallParts({
  burrow,
  detail,
  onCheck,
  checking,
  level,
  titled,
}: DetailPageProps & {
  level: 'h2' | 'h3' /** Without its own INSTALL label under the step's “Install”. */;
  titled: boolean;
}) {
  const { unavailable } = useDelivery(detail);
  return (
    <>
      {titled && <SectionLabel as={level}>{FEEDBACK_TEXT.install}</SectionLabel>}
      <IntegrationSnippets detail={detail} />
      {!unavailable && (
        <>
          <SectionLabel as={level}>{FEEDBACK_TEXT.testReport}</SectionLabel>
          <TestReport burrow={burrow} detail={detail} onCheck={onCheck} checking={checking} />
        </>
      )}
    </>
  );
}

function InstallStep({ burrow, detail, onCheck, checking }: DetailPageProps) {
  const ids = useId();
  const i = detail.integration;
  const at = stepIndex('install');
  return (
    <Frame
      title={i.name}
      meta={metaOf(i)}
      bar={
        <div className={page.bar}>
          <p className={page.barNote}>{FEEDBACK_TEXT.created}</p>
          <div className={page.barActions}>
            <RouterButtonLink variant="secondary" size="md" to="/settings/feedback/$id" params={{ id: i.id }}>
              {FEEDBACK_TEXT.editSettings}
            </RouterButtonLink>
            <RouterButtonLink
              variant="primary"
              size="md"
              to="/settings"
              search={{ tab: 'connections', connection: 'feedback' }}
            >
              {FEEDBACK_TEXT.done}
            </RouterButtonLink>
          </div>
        </div>
      }
    >
      <Stepper current="install" reachable={() => false} />
      <section className={page.panel} aria-labelledby={`${ids}-title`}>
        <PanelHead
          id={`${ids}-title`}
          title={STEPS[at]?.title ?? ''}
          counter={stepCounter(at + 1, STEPS.length)}
        />
        <div className={styles.stack}>
          <InstallParts
            burrow={burrow}
            detail={detail}
            onCheck={onCheck}
            checking={checking}
            level="h3"
            titled={false}
          />
          <SectionLabel as="h3">{FEEDBACK_TEXT.status}</SectionLabel>
          <IntegrationStatus burrow={burrow} detail={detail} />
          <SectionLabel as="h3">{FEEDBACK_TEXT.health}</SectionLabel>
          <IntegrationHealth burrow={burrow} detail={detail} />
        </div>
      </section>
    </Frame>
  );
}

function EditIntegration({
  burrow,
  detail,
  onCheck,
  checking,
  reload,
}: DetailPageProps & { reload: () => Promise<FeedbackIntegration | null> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const ids = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const { data: boot } = useBootstrap({ params: { burrow } });
  const i = detail.integration;

  const f = useIntegrationForm({
    burrow,
    integration: i,
    onConflict: reload,
    onSaved: (saved) => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.listIntegrations) });
      void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.getIntegration, { id: saved.id }) });
      toast.show(`${saved.name} saved.`);
    },
  });
  useLeaveGuard(f.dirty);

  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'UTC';
  const by = boot?.principals.find((p) => p.id === i.updatedById)?.name ?? i.updatedById;
  const changed = lastChangedLine(formatDate(i.updatedAt, timeZone, { now: Date.now() }), by, i.revision);

  async function save() {
    const result = await f.submit();
    if (!result.ok) focusFirstInvalid(formRef.current);
  }

  const sections: { key: SettingsStep | 'advanced'; title: string; body: ReactNode }[] = [
    { key: 'site', title: STEPS[0]?.title ?? '', body: <SiteFields f={f} /> },
    { key: 'reports', title: STEPS[1]?.title ?? '', body: <ReportsFields f={f} /> },
    { key: 'widget', title: STEPS[2]?.title ?? '', body: <WidgetFields f={f} /> },
    { key: 'advanced', title: FEEDBACK_TEXT.advanced, body: <PrivacyFields f={f} /> },
  ];

  return (
    <Frame
      title={i.name}
      meta={metaOf(i)}
      bar={
        <div className={page.bar} data-dirty={f.dirty || undefined}>
          {f.problem ? (
            <ProblemNote problem={f.problem} />
          ) : (
            <p className={cx(page.barNote, f.dirty && page.barDirty)} aria-live="polite">
              {f.dirty ? FEEDBACK_TEXT.unsaved : changed}
            </p>
          )}
          <div className={page.barActions}>
            <Button variant="secondary" size="md" onClick={f.discard} disabled={!f.dirty || f.busy}>
              {FEEDBACK_TEXT.discard}
            </Button>
            <Button
              type="submit"
              form={`${ids}-form`}
              variant="primary"
              size="md"
              disabled={f.busy || !f.dirty}
            >
              {FEEDBACK_TEXT.save}
            </Button>
          </div>
        </div>
      }
    >
      <section className={page.section} aria-labelledby={`${ids}-status`}>
        <SectionLabel as="h2" id={`${ids}-status`}>
          {FEEDBACK_TEXT.status}
        </SectionLabel>
        <IntegrationStatus burrow={burrow} detail={detail} />
      </section>
      <section className={page.section} aria-labelledby={`${ids}-health`}>
        <SectionLabel as="h2" id={`${ids}-health`}>
          {FEEDBACK_TEXT.health}
        </SectionLabel>
        <IntegrationHealth burrow={burrow} detail={detail} />
      </section>

      <form
        id={`${ids}-form`}
        ref={formRef}
        className={page.sections}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
        aria-label="Integration settings"
      >
        {sections.map((s) => (
          <section key={s.key} className={page.panel} aria-labelledby={`${ids}-${s.key}`}>
            <PanelHead id={`${ids}-${s.key}`} title={s.title} />
            <div className={styles.form}>{s.body}</div>
          </section>
        ))}
      </form>

      <section className={page.section} aria-label={FEEDBACK_TEXT.install}>
        <div className={styles.stack}>
          <InstallParts
            burrow={burrow}
            detail={detail}
            onCheck={onCheck}
            checking={checking}
            level="h2"
            titled
          />
        </div>
      </section>
    </Frame>
  );
}
