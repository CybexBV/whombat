import { WhombatAvatar } from '@whombat/avatars/react';
import { ApiError, agentFaceOf, InvalidRequestError } from '@whombat/client';
import { useApiMutation, useRepos, useTheAgent } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { FeedbackIntegration } from '@whombat/core/domain';
import { MessagesSquare } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { errorText, FEEDBACK_TEXT, feedbackWords, settle } from './copy';
import styles from './Feedback.module.css';
import {
  assessorProblem,
  emptyForm,
  type FieldErrors,
  type FieldKey,
  formOf,
  LIMIT_KEYS,
  type LimitKey,
  limitBounds,
  originLines,
  type SettingsForm,
  serverErrors,
  settingsInput,
  validateForm,
} from './settingsForm';
import { errorsIn, firstStepWithErrors, SETTINGS_STEPS, type SettingsStep } from './steps';
import { useReportsDestination } from './useFeedbackWords';

const LIMIT_LABELS: Record<LimitKey, { label: string; unit: string }> = {
  reportsPerHour: { label: 'REPORTS PER HOUR', unit: 'for the whole site' },
  reportsPerDay: { label: 'REPORTS PER DAY', unit: 'for the whole site' },
  perSourcePerHour: { label: 'PER VISITOR PER HOUR', unit: 'from one address' },
  maxAttachments: { label: 'SCREENSHOTS', unit: 'per report' },
  maxAttachmentBytes: { label: 'SCREENSHOT SIZE', unit: 'KB each' },
  assessmentsPerDay: { label: 'ASSESSMENTS PER DAY', unit: '0 pauses them' },
  maxConcurrentAssessments: { label: 'AT THE SAME TIME', unit: 'assessments' },
  assessmentTimeoutMinutes: { label: 'ASSESSMENT TIMEOUT', unit: 'minutes' },
};

interface FieldProps {
  label: string;
  hint?: ReactNode;
  errors?: string[];
  wide?: boolean;
  narrow?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** A labelled field with its hint and errors, linked for screen readers (the automation editor's `Field`). */
function Field({ label, hint, errors, wide, narrow, children }: FieldProps) {
  const id = useId();
  const invalid = Boolean(errors?.length);
  const describedBy = [hint ? `${id}-hint` : null, invalid ? `${id}-error` : null].filter(Boolean).join(' ');
  return (
    <div className={cx(styles.field, wide && styles.fieldWide, narrow && styles.fieldNarrow)}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid })}
      {hint && (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      )}
      {invalid && (
        <ul id={`${id}-error`} className={styles.fieldError}>
          {errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A group of choices (segmented control) with a visible mono label. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  wide,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** A row of its own (long option labels). */
  wide?: boolean;
}) {
  return (
    <div className={cx(styles.field, wide && styles.fieldWide)}>
      <span className={styles.fieldLabel} aria-hidden="true">
        {label}
      </span>
      <SegmentedControl
        label={label.toLowerCase()}
        value={value}
        options={options}
        onChange={onChange}
        className={styles.segmented}
      />
    </div>
  );
}

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function Select({
  id,
  value,
  options,
  onChange,
  invalid,
  describedBy,
  unknownLabel,
}: {
  id: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  invalid: boolean;
  describedBy: string | undefined;
  /** What a saved value that isn't among the options is called (a channel you're not in). */
  unknownLabel?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <select
      id={id}
      className={styles.select}
      value={value}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    >
      {!known && <option value={value}>{value ? (unknownLabel ?? value) : 'Choose…'}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface IntegrationFormOptions {
  burrow: string;
  /** The integration being edited, as the server has it now; null creates one. */
  integration: FeedbackIntegration | null;
  onSaved: (integration: FeedbackIntegration) => void;
  /** Called on a 409: the caller reloads and hands the fresh integration back. */
  onConflict: () => Promise<FeedbackIntegration | null>;
}

/** What Create / Save did: saved, or not, and then the step to show (the first with a problem), if any. */
export type SubmitResult = { ok: true } | { ok: false; step: SettingsStep | null };

const CHECK_FIELDS = 'Check the highlighted fields.';

/**
 * The integration editor's state, shared by the stepper (New integration) and the edit page: every
 * `FeedbackIntegrationSettings` field, validated with the schema the server uses (and the server's own field
 * errors). A step's problems show once the person tried to leave it (Next, Create, Save), then live. Updates send
 * the revision the editor started from; when someone else saved in between, the server answers 409 and the form
 * reloads their version.
 */
export function useIntegrationForm({ burrow, integration, onSaved, onConflict }: IntegrationFormOptions) {
  const reposQuery = useRepos({ params: { burrow } });
  const create = useApiMutation(api.feedback.createIntegration);
  const update = useApiMutation(api.feedback.updateIntegration);
  // The agent assesses every report and builds the fix once you say yes (Whombat one-agent.md OA-16; AP-4935):
  // nobody to pick. Reports come to your Feedback, never a channel (AP-4936).
  const { agent } = useTheAgent(burrow);
  const assessorWhyNot = agent ? assessorProblem(agent) : null;
  const sent = useMemo(
    () => ({ handoff: agent && !assessorWhyNot ? ('on' as const) : ('off' as const) }),
    [agent, assessorWhyNot],
  );
  const destination = useReportsDestination(burrow);

  const [base, setBase] = useState(integration);
  const [form, setForm] = useState<SettingsForm>(() => (integration ? formOf(integration) : emptyForm()));
  /** The server's field errors for what was last sent; cleared when the form changes. */
  const [refused, setRefused] = useState<FieldErrors>({});
  /** The steps the person tried to leave (or save): their problems show live. */
  const [tried, setTried] = useState<ReadonlySet<SettingsStep>>(() => new Set());
  /** A new integration: whether the person changed anything (for “leave without saving?”). */
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  // The integration changed on the server while the page is open (a switch flipped, someone saved): switches
  // bump the revision without touching the settings, so the form keeps its edits; other changes replace an
  // untouched form, and an edited one meets the 409 when it saves.
  useEffect(() => {
    if (!integration || !base || integration.revision === base.revision) return;
    const same =
      JSON.stringify(settingsInput(formOf(integration), sent)) ===
      JSON.stringify(settingsInput(formOf(base), sent));
    const edited =
      JSON.stringify(settingsInput(form, sent)) !== JSON.stringify(settingsInput(formOf(base), sent));
    if (same || !edited) {
      setBase(integration);
      if (!same) setForm(formOf(integration));
    }
  }, [integration, base, form, sent]);

  const repos = (reposQuery.data?.repos ?? []).filter((r) => r.enabled || r.id === form.repoId);
  const repoOptions: SelectOption[] = [
    { value: '', label: 'None — no access to code' },
    ...repos.map((r) => ({ value: r.id, label: r.fullName })),
  ];

  const edited = () => {
    setRefused({});
    setProblem(null);
    setTouched(true);
  };
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    edited();
  };
  const validation = useMemo(() => validateForm(form, sent), [form, sent]);
  const schemaErrors: FieldErrors = validation.ok ? {} : validation.errors;
  const errors: FieldErrors = { ...errorsIn(schemaErrors, tried), ...refused };
  const setLimit = (key: LimitKey, value: string) => set('limits', { ...form.limits, [key]: value });
  const err = (key: FieldKey) => errors[key];

  const dirty = base
    ? JSON.stringify(settingsInput(form, sent)) !== JSON.stringify(settingsInput(formOf(base), sent))
    : touched;

  /** Marks `steps` as tried and returns their problems (and says so when there are any). */
  function check(steps: readonly SettingsStep[]): FieldErrors {
    setTried((prev) => new Set([...prev, ...steps]));
    const bad = errorsIn(schemaErrors, steps);
    setProblem(Object.keys(bad).length ? CHECK_FIELDS : null);
    return bad;
  }

  /** How many problems the given steps have now (without showing them). */
  const problemsIn = (steps: readonly SettingsStep[]) => Object.keys(errorsIn(schemaErrors, steps)).length;

  /** Back to what the server has (the edit page's Discard). */
  function discard() {
    if (base) setForm(formOf(base));
    setRefused({});
    setTried(new Set());
    setProblem(null);
    setTouched(false);
  }

  async function submit(): Promise<SubmitResult> {
    if (busy) return { ok: false, step: null };
    const bad = check(SETTINGS_STEPS);
    if (!validation.ok) return { ok: false, step: firstStepWithErrors(bad) };
    try {
      const result = base
        ? await update.mutateAsync({
            params: { burrow, id: base.id },
            body: { revision: base.revision, settings: validation.settings },
          })
        : await create.mutateAsync({ params: { burrow }, body: validation.settings });
      const settled = settle(result);
      if (!settled.ok) {
        setProblem(settled.text);
        return { ok: false, step: null };
      }
      const saved = settled.data.integration;
      if (base) {
        setBase(saved);
        setForm(formOf(saved));
        setTried(new Set());
      }
      setTouched(false);
      onSaved(saved);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && base) {
        const fresh = await onConflict();
        if (fresh) {
          setBase(fresh);
          setForm(formOf(fresh));
        }
        setProblem(
          'Someone changed this integration while you were editing. Their version is loaded now: check it and save again.',
        );
        return { ok: false, step: null };
      }
      if ((e instanceof ApiError || e instanceof InvalidRequestError) && Object.keys(e.fields).length) {
        const fields = serverErrors(e.fields, settingsInput(form, sent));
        setRefused(fields);
        setProblem(e instanceof ApiError ? e.message : CHECK_FIELDS);
        return { ok: false, step: firstStepWithErrors(fields) };
      }
      setProblem(errorText(e));
      return { ok: false, step: null };
    }
  }

  return {
    burrow,
    base,
    form,
    set,
    setLimit,
    err,
    errors,
    problem,
    busy,
    dirty,
    check,
    problemsIn,
    discard,
    submit,
    /** The agent, who assesses and builds the fix (AP-4935); why it can't assess read-only, or null. */
    agent,
    assessorWhyNot,
    /** Where reports go now (AP-1827): your Feedback; null for a new integration. */
    chat: { now: base ? destination(base) : null },
    reposFailed: Boolean(reposQuery.error && !reposQuery.data),
    options: {
      repos: repoOptions,
    },
  };
}

export type IntegrationFormState = ReturnType<typeof useIntegrationForm>;

/* Sections ---------------------------------------------------------------------------------------- */

/** Step 1, Name & site: the name, what visitors see and the allowed origins with their live check. */
export function SiteFields({ f }: { f: IntegrationFormState }) {
  const origins = originLines(f.form.origins);
  return (
    <>
      <section className={styles.group}>
        <SectionLabel as="h3">BASICS</SectionLabel>
        <div className={styles.fields}>
          <Field label="NAME" hint="For you: “Billing portal”." errors={f.err('name')}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                className={styles.input}
                value={f.form.name}
                maxLength={80}
                invalid={invalid}
                aria-describedby={describedBy}
                onChange={(e) => f.set('name', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="PRODUCT"
            hint="What visitors see: “Report a problem with Lumio”."
            errors={f.err('productLabel')}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                className={styles.input}
                value={f.form.productLabel}
                maxLength={60}
                invalid={invalid}
                aria-describedby={describedBy}
                onChange={(e) => f.set('productLabel', e.target.value)}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={styles.group}>
        <SectionLabel as="h3">WHERE IT RUNS</SectionLabel>
        <Field
          wide
          label="ALLOWED ORIGINS"
          hint="One per line, exactly as the browser shows it: https://app.example.com. No paths or wildcards; http:// only for localhost."
          errors={f.err('allowedOrigins')}
        >
          {({ id, describedBy, invalid }) => (
            <>
              <textarea
                id={id}
                className={cx(styles.textarea, styles.textareaMono)}
                value={f.form.origins}
                spellCheck={false}
                autoCapitalize="off"
                placeholder="https://app.example.com"
                aria-invalid={invalid || undefined}
                aria-describedby={[describedBy, origins.length ? `${id}-origins` : null]
                  .filter(Boolean)
                  .join(' ')}
                onChange={(e) => f.set('origins', e.target.value)}
              />
              {origins.length > 0 && (
                <ul id={`${id}-origins`} className={styles.origins} aria-live="polite">
                  {origins.map(({ line, origin }) => (
                    <li key={line} className={origin ? styles.originOk : styles.originBad}>
                      {origin
                        ? origin === line
                          ? `✓ ${origin}`
                          : `✓ ${line} → ${origin}`
                        : `✗ ${line}: not an exact origin`}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Field>
      </section>
    </>
  );
}

/**
 * REPORTS GO TO (feedback-chat.md AP-1831; one-agent.md AP-4936): Feedback, a link once it exists. Never a channel.
 */
function ChatTarget({ f }: { f: IntegrationFormState }) {
  const id = useId();
  const navigate = useNavigateHref();
  const { words: agent } = useTheAgent(f.burrow);
  const words = feedbackWords(agent.name).chat;
  const href = f.chat.now?.href ?? null;
  const label = words.yours;
  return (
    <fieldset className={styles.field} aria-describedby={`${id}-hint`}>
      <legend className={cx(styles.fieldLabel, styles.legend)}>{words.label}</legend>
      <div className={styles.chatTarget}>
        <Icon icon={MessagesSquare} size={16} className={styles.chatIcon} />
        <span className={styles.chatName}>{label.charAt(0).toUpperCase() + label.slice(1)}</span>
        {href && (
          <a
            href={href}
            className={styles.inlineLink}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(href);
            }}
          >
            {words.open}
          </a>
        )}
      </div>
      <span id={`${id}-hint`} className={styles.fieldHint}>
        {words.hint}
      </span>
    </fieldset>
  );
}

/**
 * ASSESSED BY and BUILT BY (one-agent.md AP-4935): the agent, shown rather than picked, with what it does; while it can't
 * be kept read-only, why, and that reports aren't assessed (`assessorProblem`, the server's rule).
 */
function AgentLine({
  label,
  name,
  face,
  hint,
  problem,
}: {
  label: string;
  name: string;
  face: ReturnType<typeof agentFaceOf> | null;
  hint: string;
  problem?: string | null | undefined;
}) {
  const id = useId();
  return (
    <fieldset
      className={cx(styles.field, styles.fieldWide)}
      aria-describedby={`${id}-hint`}
      data-feedback-agent=""
    >
      <legend className={cx(styles.fieldLabel, styles.legend)}>{label}</legend>
      <div className={styles.chatTarget}>
        {face ? <WhombatAvatar face={face} size={20} decorative /> : null}
        <span className={styles.chatName}>{name}</span>
      </div>
      <span id={`${id}-hint`} className={problem ? styles.fieldError : styles.fieldHint}>
        {problem ?? hint}
      </span>
    </fieldset>
  );
}

/** Step 2, Where reports go: where they come to, the repository, who assesses, project context and who builds fixes. */
export function ReportsFields({ f }: { f: IntegrationFormState }) {
  const { form, options } = f;
  // The agent by its name (AP-1804, AP-4935), and Feedback where reports go (AP-1827).
  const { words: named } = useTheAgent(f.burrow);
  const words = feedbackWords(named.name);
  const face = f.agent ? agentFaceOf(f.agent) : null;
  const whyNot = f.assessorWhyNot
    ? `${named.Name} can’t assess these reports: ${f.assessorWhyNot}.`
    : (f.err('agentId')?.[0] ?? null);
  return (
    <>
      {/* The step's own title (“Where reports go”) heads this group. */}
      <section className={styles.group}>
        <div className={styles.fields}>
          <ChatTarget f={f} />
          <Field
            label="REPOSITORY"
            hint={f.reposFailed ? words.reposFailed : words.repoHint}
            errors={f.err('repoId')}
          >
            {(ids) => (
              <Select
                {...ids}
                value={form.repoId}
                options={options.repos}
                onChange={(v) => f.set('repoId', v)}
              />
            )}
          </Field>
          <AgentLine
            label={words.assessor}
            name={named.Name}
            face={face}
            hint={words.assessorHint}
            problem={whyNot}
          />
          <Field wide label="PROJECT CONTEXT" hint={words.contextHint} errors={f.err('projectContext')}>
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className={styles.textarea}
                value={form.projectContext}
                maxLength={4000}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(e) => f.set('projectContext', e.target.value)}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={styles.group}>
        <SectionLabel as="h3">{words.handoff}</SectionLabel>
        <AgentLine
          label={words.developer}
          name={named.Name}
          face={face}
          hint={words.developerHint}
          problem={f.err('handoffAgentId')?.[0]}
        />
      </section>
    </>
  );
}

/**
 * Step 3, Widget: report types, appearance, the button and what the form asks, whether the widget sends the pages
 * visited and offers reporter sign-in (CT-165, AP-434).
 */
export function WidgetFields({ f }: { f: IntegrationFormState }) {
  const { form } = f;
  return (
    <section className={styles.group}>
      <SectionLabel as="h3">THE FORM ON YOUR WEBSITE</SectionLabel>
      <div className={styles.fields}>
        <fieldset className={cx(styles.field, styles.fieldWide)}>
          <legend className={styles.fieldLabel}>REPORT TYPES</legend>
          <div className={styles.checks}>
            {(
              [
                ['bug', 'Bug reports'],
                ['feature', 'Feature requests'],
              ] as const
            ).map(([type, label]) => (
              <label key={type} className={styles.check}>
                <input
                  type="checkbox"
                  checked={form.types[type]}
                  onChange={(e) => f.set('types', { ...form.types, [type]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          {f.err('reportTypes') && (
            <ul className={styles.fieldError}>
              {f.err('reportTypes')?.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </fieldset>
        <Choice
          label="THEME"
          value={form.theme}
          onChange={(v) => f.set('theme', v)}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <Choice
          label="POSITION"
          value={form.position}
          onChange={(v) => f.set('position', v)}
          options={[
            { value: 'bottom-right', label: 'Bottom right' },
            { value: 'bottom-left', label: 'Bottom left' },
          ]}
        />
        <Choice
          label="BUTTON"
          value={form.launcher}
          onChange={(v) => f.set('launcher', v)}
          options={[
            { value: 'floating', label: 'Floating button' },
            { value: 'custom', label: 'Your own button' },
          ]}
        />
        <Field
          label="BUTTON LABEL"
          hint={form.launcher === 'custom' ? 'Only used by the floating button.' : undefined}
          errors={f.err('launcherLabel')}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              className={styles.input}
              value={form.launcherLabel}
              maxLength={40}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => f.set('launcherLabel', e.target.value)}
            />
          )}
        </Field>
        <Choice
          label="ASK FOR A NAME"
          value={form.contactName}
          onChange={(v) => f.set('contactName', v)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'optional', label: 'Optional' },
          ]}
        />
        <Choice
          label="ASK FOR AN EMAIL"
          value={form.contactEmail}
          onChange={(v) => f.set('contactEmail', v)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'optional', label: 'Optional' },
          ]}
        />
        <Choice
          wide
          label={FEEDBACK_TEXT.pagesVisited}
          value={form.trail}
          onChange={(v) => f.set('trail', v)}
          options={[
            { value: 'on', label: FEEDBACK_TEXT.pagesVisitedOn },
            { value: 'off', label: FEEDBACK_TEXT.pagesVisitedOff },
          ]}
        />
        <Choice
          wide
          label={FEEDBACK_TEXT.reporterSignIn}
          value={form.reporterSignIn}
          onChange={(v) => f.set('reporterSignIn', v)}
          options={[
            { value: 'on', label: FEEDBACK_TEXT.reporterSignInOn },
            { value: 'off', label: FEEDBACK_TEXT.reporterSignInOff },
          ]}
        />
        <Field
          wide
          label="PRIVACY NOTICE"
          hint="Optional. Linked under the form; https:// only."
          errors={f.err('privacyUrl')}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              className={styles.input}
              type="url"
              value={form.privacyUrl}
              placeholder="https://example.com/privacy"
              spellCheck={false}
              invalid={invalid}
              aria-describedby={describedBy}
              onChange={(e) => f.set('privacyUrl', e.target.value)}
            />
          )}
        </Field>
      </div>
    </section>
  );
}

/** Privacy and limits (on Widget, collapsed in the stepper): page addresses, context keys, retention, limits. */
export function PrivacyFields({ f }: { f: IntegrationFormState }) {
  const { form } = f;
  return (
    <>
      <section className={styles.group}>
        <SectionLabel as="h3">PRIVACY</SectionLabel>
        <div className={styles.fields}>
          <Field
            label="HIDE PARTS OF PAGE ADDRESSES"
            hint="One path per line; each * is replaced by :id. Queries and fragments are always dropped, ids are hidden anyway."
            errors={f.err('redactPaths')}
          >
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className={cx(styles.textarea, styles.textareaMono)}
                value={form.redactPaths}
                spellCheck={false}
                placeholder="/customers/*"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(e) => f.set('redactPaths', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="CUSTOM CONTEXT KEYS"
            hint="One per line. Only these keys from setContext({ custom }) are kept; none by default."
            errors={f.err('contextKeys')}
          >
            {({ id, describedBy, invalid }) => (
              <textarea
                id={id}
                className={cx(styles.textarea, styles.textareaMono)}
                value={form.contextKeys}
                spellCheck={false}
                placeholder="plan"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(e) => f.set('contextKeys', e.target.value)}
              />
            )}
          </Field>
          <Choice
            wide
            label="KEEP REPORT CONTENT"
            value={form.retention}
            onChange={(v) => f.set('retention', v)}
            options={[
              { value: 'off', label: 'Until removed by hand' },
              { value: 'days', label: 'For a number of days' },
            ]}
          />
          {form.retention === 'days' && (
            <Field
              label="DAYS"
              hint="Then text, contact details, context and screenshots are removed; the reference and history stay."
              errors={f.err('retentionDays')}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  className={styles.input}
                  type="number"
                  min={7}
                  max={3650}
                  value={form.retentionDays}
                  invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => f.set('retentionDays', e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      </section>

      <section className={styles.group}>
        <SectionLabel as="h3">LIMITS</SectionLabel>
        <div className={styles.fields}>
          {LIMIT_KEYS.map((key) => {
            const { min, max, fallback } = limitBounds(key);
            return (
              <Field
                key={key}
                narrow
                label={LIMIT_LABELS[key].label}
                hint={`${LIMIT_LABELS[key].unit} · default ${fallback}`}
                errors={f.err(`limits.${key}`)}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    className={styles.input}
                    type="number"
                    min={min}
                    max={max}
                    value={form.limits[key]}
                    invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => f.setLimit(key, e.target.value)}
                  />
                )}
              </Field>
            );
          })}
        </div>
      </section>
    </>
  );
}
