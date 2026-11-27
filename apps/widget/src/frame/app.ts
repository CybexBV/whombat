/**
 * The reporting UI inside the iframe (docs/decisions/feedback.md FB-03, FB-07 … FB-11). Plain DOM: one dialog
 * with four views (loading, unavailable, form, receipt). The form is built once per draft and updated in place,
 * so typing, focus and caret are never disturbed by a re-render.
 *
 * Two modes (Whombat `docs/decisions/feedback-drop.md` FD-27): the direct widget of a self-hosted Whombat (its own
 * `sites/…/config` and `…/reports`, unchanged), and drop mode when the frame's URL carries a site key (`drop.ts`:
 * the signed card from control, the report sealed in the browser and posted to control's drop).
 *
 * Reporter sign-in (CT-162, AP-429 … AP-433), only when the config says `reporters: true`: tabs “New report” / “Your
 * reports”, a sign-in view (email, then the 6-digit code), the reporter's reports with their status, and the session
 * kept in the one storage key of `reporter-store.ts`. A server without the routes (404) hides it again.
 */
import type { FeedbackSiteCard } from '@whombat/core/domain';
import {
  FEEDBACK_REPORTER_RESEND_S,
  normalizeReporterEmail,
  reporterSummaryOf,
} from '@whombat/core/feedback/reporters';
import { type EN, type WidgetTranslator, widgetTranslator } from '../i18n/catalog';
import type { HostMessage, ReportType, WidgetContext } from '../shared/protocol';
import { supportedVisitorLanguage } from '../shared/visitor-language';
import type { FrameBridge, FrameParams } from './bridge';
import { formatBytes, type PublicConfig, parseConfig } from './config';
import { focusables, h, ICONS, icon, translatedParts } from './dom';
import {
  buildSubmission,
  type DraftFile,
  type DraftValues,
  displayName,
  draftKey,
  EMAIL,
  emptyDraft,
  type FieldErrors,
  type FieldKey,
  fileProblem,
  fileToBase64,
  previewRows,
  type SubmissionBody,
  submissionContext,
  tooManyFiles,
  validateDraft,
} from './draft';
import {
  type DropEnvironment,
  dropPath,
  isTooLarge,
  loadCard,
  postDrop,
  reporterCodePath,
  reporterReportsPath,
  reporterSessionPath,
  type SealedDrop,
  sealSubmission,
} from './drop';
import { bytesToBase64, screenshotAcceptable } from './images';
import { clearSession, loadSession, type ReporterSession, SENT_MAX, saveSession } from './reporter-store';
import {
  endSession,
  fetchReports,
  formatDay,
  mergeReports,
  type ReporterEndpoints,
  type ReporterOutcome,
  type ReportRow,
  reportStatusText,
  requestCode,
  retryText,
  startSession,
} from './reporters';
import {
  type FetchLike,
  type Outcome,
  OutcomeError,
  postReport,
  type Receipt,
  SUBMIT_TIMEOUT_MS,
  Submitter,
} from './submit';

export const CONFIG_TIMEOUT_MS = 15_000;

const TYPE_COPY = {
  bug: { label: 'reportProblem', description: 'problemDescription', hint: 'problemHint' },
  feature: { label: 'suggestIdea', description: 'ideaDescription', hint: 'ideaHint' },
} as const satisfies Record<ReportType, Record<'label' | 'description' | 'hint', keyof typeof EN>>;

type View = 'loading' | 'unavailable' | 'form' | 'receipt' | 'signin' | 'reports';

/** A field of the sign-in view (not part of the draft). */
interface PlainField {
  wrap: HTMLElement;
  input: HTMLInputElement;
  setError(message: string | null): void;
}

interface FieldRefs {
  wrap: HTMLElement;
  control: HTMLElement;
  error: HTMLElement;
  /** Ids always in `aria-describedby` (hint, counter); the error id is added while it shows. */
  describedBy: string[];
}

export interface FrameAppOptions {
  params: FrameParams;
  bridge: FrameBridge;
  fetch: FetchLike;
  /** Where the frame's own URL resolves `./sites/…` from (tests pass the frame URL). */
  baseUrl: string;
  root: HTMLElement;
  lang?: string;
  /** Drop mode's environment (control's origin, the ancestors); used only when `params.key` is set. */
  drop?: DropEnvironment;
}

export class FrameApp {
  readonly root: HTMLElement;
  view: View = 'loading';
  config: PublicConfig | null = null;
  context: WidgetContext | null = null;
  values: DraftValues = emptyDraft('bug');
  errors: FieldErrors = {};
  receipt: Receipt | null = null;
  readonly submitter: Submitter<unknown>;
  /** Drop mode: the verified card, and the origin of the first valid loader message (FD-28 (3)). */
  card: FeedbackSiteCard | null = null;
  bridgeOrigin: string | null = null;
  /** The signed-in reporter (CT-162); kept in memory when storage is unavailable. */
  session: ReporterSession | null = null;
  /** The server answered 404 to a reporter route: sign-in is hidden again. */
  reportersOff = false;
  /** “Your reports” as last loaded. */
  reportRows: ReportRow[] | null = null;
  signinStep: 'email' | 'code' = 'email';
  /** The address the code was sent to (normalized). */
  signinEmail = '';
  /** Where a successful sign-in goes: back to the form, or to “Your reports”. */
  private signinReturn: 'form' | 'reports' = 'form';
  private resendTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the last code was asked for (ms). */
  private codeSentAt = 0;
  private reportsSeq = 0;
  private readonly opts: FrameAppOptions;
  private readonly words: WidgetTranslator;
  private dialog!: HTMLElement;
  private body!: HTMLElement;
  private foot!: HTMLElement;
  private titleEl!: HTMLElement;
  private eyebrow!: HTMLElement;
  private live!: HTMLElement;
  private tabs!: HTMLElement;
  private tabNew!: HTMLButtonElement;
  private tabReports!: HTMLButtonElement;
  private focusWhenReady = false;
  /** `open({type})` that arrived before the configuration. */
  private pendingType: ReportType | null = null;
  private urls = new Map<string, string>();
  private fileSeq = 0;
  // Form refs (valid while view === 'form').
  private form: HTMLFormElement | null = null;
  private fields = new Map<FieldKey, FieldRefs>();
  private typeInputs = new Map<ReportType, HTMLInputElement>();
  private counter: HTMLElement | null = null;
  private descriptionLabel: HTMLElement | null = null;
  private descriptionHint: HTMLElement | null = null;
  private bugOnly: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private addFiles: HTMLButtonElement | null = null;
  private fileList: HTMLUListElement | null = null;
  private previewList: HTMLElement | null = null;
  private trailPreview: HTMLElement | null = null;
  private alertBox: HTMLElement | null = null;
  private submitButton: HTMLButtonElement | null = null;

  constructor(opts: FrameAppOptions) {
    this.opts = opts;
    this.root = opts.root;
    const lang = supportedVisitorLanguage(opts.lang) ?? 'en';
    this.words = widgetTranslator(lang);
    applyFrameLanguage(this.root.ownerDocument, lang, this.words);
    const control = opts.drop?.control ?? null;
    this.submitter = this.dropMode
      ? new Submitter<unknown>(
          (sealed) =>
            control
              ? postDrop(
                  opts.fetch,
                  `${control}${dropPath(opts.params.site)}`,
                  sealed as SealedDrop,
                  SUBMIT_TIMEOUT_MS,
                  this.session?.token ?? null,
                )
              : Promise.resolve<Outcome>({ kind: 'unavailable' }),
          undefined,
          { newIdOnEdit: true },
        )
      : new Submitter<unknown>((body) =>
          postReport(
            opts.fetch,
            this.url(`sites/${encodeURIComponent(opts.params.site)}/reports`),
            body as SubmissionBody,
            SUBMIT_TIMEOUT_MS,
            this.session?.token ?? null,
          ),
        );
    this.renderShell();
    this.showLoading();
    this.root.ownerDocument.addEventListener('keydown', (event) => this.onKeydown(event));
  }

  private url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  /** Drop mode: the snippet pinned a site key (FD-27). */
  get dropMode(): boolean {
    return this.opts.params.key !== null;
  }

  /** Sign-in is offered: the config says so and the server has the routes. */
  get reportersOn(): boolean {
    return Boolean(this.config?.reporters) && !this.reportersOff;
  }

  /** The reporter routes: the runtime's own (same-origin), or control's in drop mode (CORS). */
  private get endpoints(): ReporterEndpoints {
    const site = this.opts.params.site;
    if (this.dropMode) {
      const control = this.opts.drop?.control ?? '';
      return {
        code: `${control}${reporterCodePath(site)}`,
        session: `${control}${reporterSessionPath(site)}`,
        reports: `${control}${reporterReportsPath(site)}`,
        mode: 'cors',
      };
    }
    const base = `sites/${encodeURIComponent(site)}/reporter`;
    return {
      code: this.url(`${base}/code`),
      session: this.url(`${base}/session`),
      reports: this.url(`${base}/reports`),
      mode: 'same-origin',
    };
  }

  /** Drop mode keeps Send off until the loader has spoken from the parent the URL names (FD-28 (3)). */
  private awaitingBridge(): boolean {
    return this.dropMode && this.bridgeOrigin === null;
  }

  /** Loads the site's configuration (drop mode: its verified card); unavailable on any failure. */
  async load(): Promise<void> {
    if (this.dropMode) {
      const loaded = await loadCard(this.opts.fetch, this.opts.params, {
        control: this.opts.drop?.control ?? null,
        ancestorOrigins: this.opts.drop?.ancestorOrigins ?? null,
      });
      this.card = loaded?.card ?? null;
      this.ready(loaded?.config ?? null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    const { site, parent } = this.opts.params;
    let config: PublicConfig | null = null;
    try {
      const res = await this.opts.fetch(
        this.url(`sites/${encodeURIComponent(site)}/config?parent=${encodeURIComponent(parent)}`),
        {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        },
      );
      if (res.ok) config = parseConfig(await res.json());
    } catch {
      config = null;
    } finally {
      clearTimeout(timer);
    }
    this.ready(config);
  }

  private ready(config: PublicConfig | null): void {
    if (!config) {
      this.showUnavailable();
      this.opts.bridge.post({ type: 'unavailable', payload: {} });
      return;
    }
    this.config = config;
    this.eyebrow.textContent = config.productLabel;
    this.values = emptyDraft(config.reportTypes[0] ?? 'bug');
    // Storage is touched only when the site offers sign-in (FD-28 (7) otherwise holds as it was).
    if (config.reporters) {
      this.session = loadSession(this.opts.params.site);
      if (this.session && config.contactFields.name === 'optional') this.values.name = this.session.name;
    }
    if (this.pendingType && config.reportTypes.includes(this.pendingType))
      this.values.type = this.pendingType;
    this.pendingType = null;
    this.showForm();
  }

  /**
   * A message from the loader (already checked for origin, source, instance and shape); `origin` is its
   * `event.origin`, which drop mode seals as the bridge origin.
   */
  handle(message: HostMessage, origin: string | null = null): void {
    if (origin !== null && this.bridgeOrigin === null) {
      this.bridgeOrigin = origin;
      if (this.submitButton && this.submitter.state === 'editing') this.submitButton.disabled = false;
    }
    switch (message.type) {
      case 'open': {
        this.setContext(message.payload.context);
        const type = message.payload.type;
        if (this.view === 'receipt') this.startNewDraft(false);
        // The site asked for a kind of report: back to the form from sign-in or “Your reports”.
        if (type && (this.view === 'signin' || this.view === 'reports')) this.showNewReport();
        if (type) {
          if (this.config && this.view === 'form') {
            if (this.config.reportTypes.includes(type)) this.setType(type);
          } else this.pendingType = type;
        }
        this.focusWhenReady = true;
        this.focusStart();
        break;
      }
      case 'context':
        this.setContext(message.payload.context);
        break;
      case 'close':
        // A finished report isn't shown again: the next open starts a new one.
        if (this.view === 'receipt') this.startNewDraft(false);
        break;
    }
  }

  private setContext(context: WidgetContext): void {
    this.context = context;
    this.renderPreview();
  }

  private requestClose(): void {
    this.opts.bridge.post({ type: 'close', payload: {} });
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      this.requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus stays in the dialog: Tab wraps around at both ends.
    const items = focusables(this.dialog);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = this.root.ownerDocument.activeElement;
    const inside = active instanceof HTMLElement && this.dialog.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Shell and simple views

  private renderShell(): void {
    this.eyebrow = h('p', { class: 'eyebrow' });
    this.titleEl = h('h1', { id: 'wb-title', class: 'title', tabindex: '-1' }, this.words.t('sendFeedback'));
    const close = h(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': this.words.t('close'),
        onclick: () => this.requestClose(),
      },
      icon([...ICONS.close]),
    );
    this.body = h('div', { class: 'body' });
    this.foot = h('div', { class: 'foot' });
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    this.tabNew = h(
      'button',
      { type: 'button', class: 'tab', 'aria-pressed': 'true', onclick: () => this.showNewReport() },
      this.words.t('newReport'),
    );
    this.tabReports = h(
      'button',
      { type: 'button', class: 'tab', 'aria-pressed': 'false', onclick: () => this.showYourReports() },
      this.words.t('yourReports'),
    );
    this.tabs = h(
      'div',
      { class: 'tabs', role: 'group', 'aria-label': this.words.t('feedback'), hidden: true },
      this.tabNew,
      this.tabReports,
    );
    this.dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wb-title' },
      h('header', { class: 'head' }, h('div', { class: 'head-text' }, this.eyebrow, this.titleEl), close),
      this.tabs,
      this.body,
      this.foot,
      this.live,
    );
    this.root.replaceChildren(this.dialog);
  }

  private clearForm(): void {
    this.form = null;
    this.fields.clear();
    this.typeInputs.clear();
    this.counter = this.descriptionLabel = this.descriptionHint = this.bugOnly = null;
    this.fileInput =
      this.addFiles =
      this.fileList =
      this.previewList =
      this.trailPreview =
      this.alertBox =
      this.submitButton =
        null;
  }

  private setBody(view: View, body: Node[], foot: Node[]): void {
    if (view !== 'signin') clearTimeout(this.resendTimer);
    this.view = view;
    this.dialog.dataset.view = view;
    this.body.replaceChildren(...body);
    this.body.scrollTop = 0;
    this.foot.replaceChildren(...foot);
    this.updateTabs();
  }

  /** The tabs show with sign-in on a form-like view; “Your reports” is pressed for sign-in and the list. */
  private updateTabs(): void {
    const show = this.reportersOn && this.view !== 'loading' && this.view !== 'unavailable';
    this.tabs.hidden = !show;
    this.dialog.dataset.tabs = show ? 'true' : 'false';
    const reports = this.view === 'signin' || this.view === 'reports';
    this.tabNew.setAttribute('aria-pressed', reports ? 'false' : 'true');
    this.tabReports.setAttribute('aria-pressed', reports ? 'true' : 'false');
  }

  private closeButton(primary: boolean): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: primary ? 'button primary' : 'button secondary',
        onclick: () => this.requestClose(),
      },
      this.words.t('close'),
    );
  }

  showLoading(): void {
    this.clearForm();
    this.setBody('loading', [h('p', { class: 'loading', role: 'status' }, this.words.t('loading'))], []);
  }

  showUnavailable(): void {
    this.clearForm();
    this.revokeAll();
    this.setBody(
      'unavailable',
      [h('p', { class: 'notice', role: 'status' }, this.words.t('unavailable'))],
      [this.closeButton(true)],
    );
    this.focusStart();
  }

  // ------------------------------------------------------------------------------------------------------
  // The form

  private fieldIds(key: string) {
    return { control: `wb-${key}`, error: `wb-${key}-error`, hint: `wb-${key}-hint` };
  }

  private labelText(text: string, optional: boolean): (Node | string)[] {
    return optional ? [text, ' ', h('span', { class: 'optional' }, this.words.t('optional'))] : [text];
  }

  private textField(
    key: 'description' | 'expected' | 'name' | 'email',
    label: string,
    options: {
      optional: boolean;
      multiline?: boolean;
      rows?: number;
      hint?: string;
      type?: string;
      autocomplete?: string;
      placeholder?: string;
      counter?: boolean;
    },
  ): HTMLElement {
    const ids = this.fieldIds(key);
    const describedBy: string[] = [];
    const labelEl = h(
      'label',
      { for: ids.control, class: 'label' },
      ...this.labelText(label, options.optional),
    );
    const hint = options.hint ? h('p', { id: ids.hint, class: 'hint' }, options.hint) : null;
    if (hint) describedBy.push(ids.hint);
    const common = {
      id: ids.control,
      name: key,
      class: 'input',
      autocomplete: options.autocomplete ?? 'off',
      placeholder: options.placeholder,
      'aria-required': options.optional ? undefined : 'true',
      spellcheck: options.multiline ? 'true' : undefined,
    };
    const control = options.multiline
      ? h('textarea', { ...common, rows: options.rows ?? 4 })
      : h('input', { ...common, type: options.type ?? 'text' });
    control.value = this.values[key];
    control.addEventListener('input', () => {
      this.values[key] = control.value;
      if (key === 'description') this.updateCounter();
      if (this.errors[key]) this.setError(key, undefined);
    });
    const error = h('p', { id: ids.error, class: 'error', hidden: true });
    let counter: HTMLElement | null = null;
    if (options.counter) {
      counter = h('p', { id: `${ids.control}-count`, class: 'counter' });
      describedBy.push(counter.id);
      this.counter = counter;
    }
    const wrap = h(
      'div',
      { class: 'field', 'data-field': key },
      labelEl,
      hint,
      control,
      counter || error ? h('div', { class: 'field-foot' }, error, counter) : null,
    );
    if (key === 'description') {
      this.descriptionLabel = labelEl;
      this.descriptionHint = hint;
    }
    this.fields.set(key, { wrap, control, error, describedBy });
    this.applyDescribedBy(key);
    return wrap;
  }

  private applyDescribedBy(key: FieldKey): void {
    const f = this.fields.get(key);
    if (!f) return;
    const ids = [...f.describedBy];
    if (this.errors[key]) ids.push(f.error.id);
    if (ids.length) f.control.setAttribute('aria-describedby', ids.join(' '));
    else f.control.removeAttribute('aria-describedby');
  }

  showForm(): void {
    const config = this.config;
    if (!config) return;
    this.clearForm();
    this.errors = {};
    const v = this.values;
    const parts: Node[] = [];

    if (config.reportTypes.length > 1) {
      const group = h(
        'fieldset',
        { class: 'types', 'data-field': 'type' },
        h('legend', { class: 'sr-only' }, this.words.t('kindOfFeedback')),
      );
      const segmented = h('div', { class: 'segmented' });
      for (const type of config.reportTypes) {
        const input = h('input', {
          type: 'radio',
          name: 'type',
          value: type,
          id: `wb-type-${type}`,
          class: 'sr-only',
        });
        input.checked = v.type === type;
        input.addEventListener('change', () => input.checked && this.setType(type));
        this.typeInputs.set(type, input);
        segmented.append(
          h(
            'label',
            { for: input.id, class: 'segment' },
            input,
            h('span', {}, this.words.t(TYPE_COPY[type].label)),
          ),
        );
      }
      group.append(segmented);
      const error = h('p', { id: 'wb-type-error', class: 'error', hidden: true });
      group.append(error);
      this.fields.set('type', { wrap: group, control: segmented, error, describedBy: [] });
      parts.push(group);
    }

    parts.push(
      this.textField('description', this.words.t(TYPE_COPY[v.type].description), {
        optional: false,
        multiline: true,
        rows: 5,
        hint: this.words.t(TYPE_COPY[v.type].hint),
        counter: true,
      }),
    );
    this.bugOnly = h(
      'div',
      { class: 'group' },
      this.textField('expected', this.words.t('expected'), {
        optional: true,
        multiline: true,
        rows: 3,
      }),
    );
    this.bugOnly.hidden = v.type !== 'bug';
    parts.push(this.bugOnly);

    if (config.attachments.max > 0) parts.push(this.screenshotsField(config));

    const signedIn = this.reportersOn && this.session !== null;
    const emailField = config.contactFields.email === 'optional' && !signedIn;
    if (config.contactFields.name === 'optional' || emailField || this.reportersOn) {
      const contact = h('div', { class: 'group', 'data-group': 'contact' });
      if (config.contactFields.name === 'optional')
        contact.append(
          this.textField('name', this.words.t('yourName'), { optional: true, autocomplete: 'name' }),
        );
      if (emailField)
        contact.append(
          this.textField('email', this.words.t('email'), {
            optional: true,
            type: 'email',
            autocomplete: 'email',
            hint: this.words.t('contactHint'),
          }),
        );
      if (signedIn) contact.append(this.signedInLine());
      else if (this.reportersOn)
        contact.append(
          h(
            'p',
            { class: 'signin-row' },
            h(
              'button',
              {
                type: 'button',
                class: 'link',
                id: 'wb-signin-link',
                onclick: () => {
                  // The link goes away with the form: focus moves to the address field.
                  this.showSignin('form');
                  this.body.querySelector<HTMLInputElement>('input')?.focus();
                },
              },
              this.words.t('signInToFollow'),
            ),
          ),
        );
      parts.push(contact);
    }

    this.previewList = h('dl', { class: 'preview-list' });
    this.trailPreview = h('div', { class: 'trail-preview', hidden: true });
    const details = h(
      'details',
      { class: 'preview' },
      h('summary', {}, this.words.t('whatWillBeSent')),
      h(
        'div',
        { class: 'preview-body' },
        h('p', {}, this.words.t('answersAnd')),
        this.previewList,
        this.trailPreview,
        h('p', { class: 'hint' }, this.words.t('privacyHint')),
      ),
    );
    details.addEventListener('toggle', () => {
      if (details.open) this.opts.bridge.post({ type: 'request-context', payload: {} });
    });
    parts.push(details);

    if (config.privacyUrl)
      parts.push(
        h(
          'p',
          { class: 'privacy' },
          h(
            'a',
            { href: config.privacyUrl, target: '_blank', rel: 'noopener noreferrer' },
            this.words.t('privacyNotice'),
            h('span', { class: 'sr-only' }, this.words.t('newTab')),
            icon([...ICONS.external], 14),
          ),
        ),
      );

    // In the footer, next to Send: always visible, however far the form is scrolled.
    this.alertBox = h('div', { class: 'alert', role: 'alert', hidden: true });

    this.submitButton = h(
      'button',
      { type: 'submit', class: 'button primary', form: 'wb-form' },
      this.words.t('send'),
    );
    this.submitButton.disabled = this.awaitingBridge();
    const cancel = h(
      'button',
      { type: 'button', class: 'button secondary', onclick: () => this.requestClose() },
      this.words.t('cancel'),
    );
    this.form = h(
      'form',
      { id: 'wb-form', class: 'form', novalidate: true, 'aria-labelledby': 'wb-title' },
      ...parts,
    );
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.setBody('form', [this.form], [this.alertBox, cancel, this.submitButton]);
    this.updateCounter();
    this.renderFiles();
    this.renderPreview();
    if (this.focusWhenReady) this.focusStart();
  }

  private screenshotsField(config: PublicConfig): HTMLElement {
    const ids = this.fieldIds('attachments');
    const max = config.attachments.max;
    this.fileInput = h('input', {
      type: 'file',
      id: ids.control,
      class: 'file-input',
      accept: config.attachments.types.join(','),
      multiple: max > 1,
      tabindex: '-1',
      'aria-hidden': 'true',
    });
    this.fileInput.addEventListener('change', () => {
      const input = this.fileInput;
      if (!input?.files) return;
      this.addChosen(Array.from(input.files));
      input.value = '';
    });
    this.addFiles = h(
      'button',
      {
        type: 'button',
        class: 'button secondary small',
        'aria-describedby': ids.hint,
        onclick: () => this.fileInput?.click(),
      },
      icon([...ICONS.image], 16),
      this.words.tp('addScreenshots', max),
    );
    const [first, second] = [...new Set(config.attachments.types)].map((t) =>
      t === 'image/png' ? 'PNG' : 'JPEG',
    );
    const kinds = first && second ? this.words.t('eitherImageType', { first, second }) : (first ?? '');
    const hint = h(
      'p',
      { id: ids.hint, class: 'hint' },
      this.words.t('imageLimits', {
        kinds,
        max: max.toLocaleString(this.words.locale),
        size: formatBytes(config.attachments.maxBytes, this.words.locale),
      }),
    );
    this.fileList = h('ul', { class: 'files', 'aria-label': this.words.t('screenshots') });
    const error = h('p', { id: ids.error, class: 'error', hidden: true });
    const wrap = h(
      'div',
      { class: 'field', 'data-field': 'attachments' },
      h(
        'p',
        { class: 'label', id: 'wb-attachments-label' },
        ...this.labelText(this.words.t('screenshots'), true),
      ),
      hint,
      this.fileList,
      h('div', { class: 'file-actions' }, this.addFiles),
      this.fileInput,
      error,
    );
    this.fields.set('attachments', { wrap, control: this.addFiles, error, describedBy: [ids.hint] });
    return wrap;
  }

  /** Adds chosen files that pass the checks; says why the others weren't added. */
  addChosen(files: File[]): void {
    const config = this.config;
    if (!config) return;
    const problems: string[] = [];
    for (const file of files) {
      if (this.values.files.length >= config.attachments.max) {
        problems.push(tooManyFiles(config, this.words));
        break;
      }
      const problem = fileProblem(file, config, this.words);
      if (problem) {
        problems.push(problem);
        continue;
      }
      this.values.files.push({
        key: `f${++this.fileSeq}`,
        name: file.name,
        type: file.type,
        size: file.size,
        blob: file,
      });
    }
    this.clearFileErrors();
    this.setError('attachments', problems.length ? problems.join(' ') : undefined);
    this.renderFiles();
    this.renderPreview();
  }

  private clearFileErrors(): void {
    for (const key of Object.keys(this.errors) as FieldKey[])
      if (key.startsWith('attachments.')) delete this.errors[key];
  }

  removeFile(key: string): void {
    const index = this.values.files.findIndex((f) => f.key === key);
    if (index < 0) return;
    const [removed] = this.values.files.splice(index, 1);
    if (removed) this.revoke(removed.key);
    this.clearFileErrors();
    this.setError('attachments', undefined);
    this.renderFiles();
    this.renderPreview();
    const name = displayName(removed?.name ?? '', this.words.t('screenshotFileName'));
    this.live.textContent = this.words.t('removedFile', { name });
    this.addFiles?.focus();
  }

  private thumbUrl(file: DraftFile): string {
    let url = this.urls.get(file.key);
    if (!url) {
      url = URL.createObjectURL(file.blob);
      this.urls.set(file.key, url);
    }
    return url;
  }

  private revoke(key: string): void {
    const url = this.urls.get(key);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(key);
  }

  private revokeAll(): void {
    for (const key of [...this.urls.keys()]) this.revoke(key);
  }

  private renderFiles(): void {
    const list = this.fileList;
    const config = this.config;
    if (!list || !config) return;
    list.replaceChildren(
      ...this.values.files.map((file, i) => {
        const name = displayName(file.name, this.words.t('screenshotFileName'));
        const error = this.errors[`attachments.${i}`];
        const errorId = `wb-attachments-${i}-error`;
        return h(
          'li',
          { class: 'file', 'data-invalid': error ? 'true' : undefined },
          h('img', { class: 'thumb', src: this.thumbUrl(file), alt: '' }),
          h(
            'div',
            { class: 'file-text' },
            h('span', { class: 'file-name' }, name),
            h('span', { class: 'file-size' }, formatBytes(file.size, this.words.locale)),
            error ? h('span', { class: 'error', id: errorId }, error) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button',
              'aria-label': this.words.t('removeFile', { name }),
              'aria-describedby': error ? errorId : undefined,
              onclick: () => this.removeFile(file.key),
            },
            icon([...ICONS.close], 16),
          ),
        );
      }),
    );
    list.hidden = this.values.files.length === 0;
    if (this.addFiles) this.addFiles.hidden = this.values.files.length >= config.attachments.max;
  }

  private renderPreview(): void {
    const list = this.previewList;
    const config = this.config;
    if (!list || !config) return;
    const context = submissionContext(this.context, config);
    const rows = previewRows(context, this.values.files, this.words);
    list.replaceChildren(...rows.flatMap((row) => [h('dt', {}, row.label), h('dd', {}, row.value)]));
    if (rows.length === 0) list.replaceChildren(h('dd', {}, this.words.t('nothingElse')));
    const trail = context.trail ?? [];
    if (this.trailPreview) {
      this.trailPreview.hidden = trail.length === 0;
      this.trailPreview.replaceChildren(
        h('p', { id: 'wb-trail-label' }, this.words.t('trail')),
        h(
          'ol',
          { class: 'trail-list', 'aria-labelledby': 'wb-trail-label' },
          ...trail.map((step) =>
            h(
              'li',
              {},
              h('span', { class: 'trail-url' }, step.url),
              step.title ? h('span', { class: 'trail-title' }, step.title) : null,
            ),
          ),
        ),
      );
    }
  }

  private updateCounter(): void {
    if (!this.counter || !this.config) return;
    const n = this.values.description.trim().length;
    const limit = this.config.text.description;
    this.counter.textContent = `${n.toLocaleString(this.words.locale)} / ${limit.toLocaleString(this.words.locale)}`;
    this.counter.dataset.over = n > limit ? 'true' : 'false';
  }

  setType(type: ReportType): void {
    this.values.type = type;
    const input = this.typeInputs.get(type);
    if (input && !input.checked) input.checked = true;
    if (this.descriptionLabel)
      this.descriptionLabel.replaceChildren(this.words.t(TYPE_COPY[type].description));
    if (this.descriptionHint) this.descriptionHint.textContent = this.words.t(TYPE_COPY[type].hint);
    if (this.bugOnly) this.bugOnly.hidden = type !== 'bug';
    if (this.errors.description) this.setError('description', undefined);
  }

  private setError(key: FieldKey, message: string | undefined): void {
    if (message) this.errors[key] = message;
    else delete this.errors[key];
    const f = this.fields.get(key);
    if (!f) return;
    f.error.textContent = message ?? '';
    f.error.hidden = !message;
    if (f.control.tagName === 'INPUT' || f.control.tagName === 'TEXTAREA') {
      if (message) f.control.setAttribute('aria-invalid', 'true');
      else f.control.removeAttribute('aria-invalid');
    }
    f.wrap.dataset.invalid = message ? 'true' : 'false';
    this.applyDescribedBy(key);
  }

  private showErrors(errors: FieldErrors): void {
    for (const key of this.fields.keys()) this.setError(key, errors[key]);
    this.errors = { ...errors };
    this.renderFiles();
  }

  /** Focus the first field with a problem, in the order the form shows them. */
  private focusFirstInvalid(): void {
    const order: FieldKey[] = ['type', 'description', 'expected', 'attachments', 'name', 'email'];
    for (const key of order) {
      if (!this.errors[key]) continue;
      const f = this.fields.get(key);
      if (key === 'type') this.typeInputs.get(this.values.type)?.focus();
      else f?.control.focus();
      return;
    }
    const fileIndex = this.values.files.findIndex((_, i) => this.errors[`attachments.${i}`]);
    if (fileIndex >= 0) this.fileList?.querySelectorAll<HTMLButtonElement>('button')[fileIndex]?.focus();
  }

  private showAlert(message: string | null, action?: { label: string; run: () => void }): void {
    const box = this.alertBox;
    if (!box) return;
    if (!message) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.replaceChildren(
      icon([...ICONS.alert], 18),
      h(
        'div',
        { class: 'alert-text' },
        h('p', {}, message),
        action
          ? h(
              'button',
              { type: 'button', class: 'button secondary small', onclick: action.run },
              action.label,
            )
          : null,
      ),
    );
    box.hidden = false;
  }

  private setBusy(busy: boolean): void {
    if (this.form) this.form.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (this.submitButton) {
      this.submitButton.disabled = busy || this.awaitingBridge();
      this.submitButton.textContent = this.words.t(busy ? 'sending' : 'send');
    }
  }

  /** Validates, then sends (once, whatever is clicked meanwhile). */
  async submit(): Promise<Outcome | null> {
    const config = this.config;
    if (!config || this.view !== 'form' || this.submitter.state !== 'editing') return null;
    if (this.awaitingBridge()) return null;
    const signedInEmail = this.reportersOn ? (this.session?.email ?? null) : null;
    const errors = validateDraft(this.values, config, signedInEmail !== null, this.words);
    const count = Object.keys(errors).length;
    if (count > 0) {
      this.showErrors(errors);
      this.showAlert(this.words.tp('checkHighlighted', count));
      this.focusFirstInvalid();
      return null;
    }
    this.showErrors({});
    this.showAlert(null);
    const values = this.values;
    const context = this.context;
    const pending = this.submitter.submit(
      this.dropMode
        ? (submissionId) => this.sealDraft(submissionId, values, context, config, signedInEmail)
        : async (submissionId) =>
            buildSubmission({
              submissionId,
              parentOrigin: this.opts.params.parent,
              values,
              context,
              config,
              signedInEmail,
              sentAt: new Date().toISOString(),
              attachments: await Promise.all(
                values.files.map(async (f) => ({
                  name: displayName(f.name),
                  contentType: f.type as 'image/png' | 'image/jpeg',
                  data: await fileToBase64(f.blob),
                })),
              ),
            }),
      draftKey(values, signedInEmail),
    );
    this.setBusy(true);
    const outcome = await pending;
    this.setBusy(false);
    if (outcome) this.handleOutcome(outcome, config);
    return outcome;
  }

  /**
   * Drop mode's body for this draft (FD-28 (4), (5)): the screenshots checked as the runtime would check them, the
   * same `FeedbackSubmission` the direct widget sends, sealed to the card's key with the frame's evidence. Known
   * outcomes (a screenshot the runtime would refuse, an envelope over the card's limit) come back without a request.
   */
  private async sealDraft(
    submissionId: string,
    values: DraftValues,
    context: WidgetContext | null,
    config: PublicConfig,
    signedInEmail: string | null,
  ): Promise<SealedDrop> {
    const card = this.card;
    const bridgeOrigin = this.bridgeOrigin;
    if (!card || !bridgeOrigin) throw new OutcomeError({ kind: 'unavailable' });
    const refused: string[] = [];
    const attachments = await Promise.all(
      values.files.map(async (f, i) => {
        const bytes = new Uint8Array(await f.blob.arrayBuffer());
        if (!screenshotAcceptable(bytes, f.type, config.attachments.maxBytes))
          refused.push(`attachments.${i}`);
        return {
          name: displayName(f.name),
          contentType: f.type as 'image/png' | 'image/jpeg',
          data: bytesToBase64(bytes),
        };
      }),
    );
    if (refused.length > 0)
      throw new OutcomeError({ kind: 'attachments', reason: 'unsupported', fields: refused });
    const submission = buildSubmission({
      submissionId,
      parentOrigin: this.opts.params.parent,
      values,
      context,
      config,
      signedInEmail,
      sentAt: new Date().toISOString(),
      attachments,
    });
    try {
      return await sealSubmission(card, submission, {
        bridgeOrigin,
        ancestorOrigins: this.opts.drop?.ancestorOrigins ?? null,
        cardSeq: card.seq,
      });
    } catch (err) {
      throw new OutcomeError(
        isTooLarge(err) ? { kind: 'attachments', reason: 'too_large', fields: [] } : { kind: 'server' },
      );
    }
  }

  private retry = () => {
    void this.submit();
  };

  private handleOutcome(outcome: Outcome, config: PublicConfig): void {
    switch (outcome.kind) {
      case 'received':
        this.remember(outcome.receipt);
        this.receipt = outcome.receipt;
        this.opts.bridge.post({ type: 'submitted', payload: { reference: outcome.receipt.reference } });
        this.showReceipt(outcome.receipt);
        return;
      case 'invalid': {
        const errors = this.serverFieldErrors(outcome.fields);
        this.showErrors(errors);
        this.showAlert(
          Object.keys(errors).length ? this.words.t('invalidFields') : this.words.t('invalidForm'),
        );
        this.focusFirstInvalid();
        return;
      }
      case 'conflict':
        this.showAlert(this.words.t('alreadySent'), {
          label: this.words.t('sendAsNew'),
          run: () => {
            this.submitter.newDraft();
            void this.submit();
          },
        });
        return;
      case 'attachments': {
        const per = outcome.fields.filter((f) => /^attachments\.\d+$/.test(f));
        const errors: FieldErrors = {};
        const size = formatBytes(config.attachments.maxBytes, this.words.locale);
        for (const f of per) errors[f as FieldKey] = this.words.t('screenshotRefusedHint', { size });
        this.showErrors(errors);
        this.showAlert(
          outcome.reason === 'too_large' && per.length === 0
            ? this.words.t('screenshotsTooLarge')
            : this.words.tp('screenshotsRefused', per.length),
        );
        this.focusFirstInvalid();
        return;
      }
      case 'rate_limited':
        this.showAlert(
          this.words.t('reportsRateLimited', { retry: retryText(outcome.retryAfter, this.words) }),
          { label: this.words.t('tryAgain'), run: this.retry },
        );
        return;
      case 'unavailable':
        this.showAlert(this.words.t('unavailable'));
        return;
      case 'server':
        this.showAlert(this.words.t('submitServer'), {
          label: this.words.t('tryAgain'),
          run: this.retry,
        });
        return;
      case 'network':
        this.showAlert(this.words.t('submitNetwork'), {
          label: this.words.t('tryAgain'),
          run: this.retry,
        });
        return;
      case 'unreadable':
        this.showAlert(this.words.t('unreadableImage'));
        return;
    }
  }

  /** Server field paths (`description`, `reporter.email`, `attachments.1`) → the form's fields. */
  private serverFieldErrors(fields: string[]): FieldErrors {
    const errors: FieldErrors = {};
    for (const field of fields) {
      if (field === 'description') errors.description = this.words.t('descriptionRefused');
      else if (field === 'expected') errors.expected = this.words.t('expectedRefused');
      else if (field === 'type') errors.type = this.words.t('chooseKind');
      else if (field === 'reporter.name' || field === 'reporter') errors.name = this.words.t('nameRefused');
      else if (field === 'reporter.email') errors.email = this.words.t('optionalEmailInvalid');
      else if (/^attachments\.\d+/.test(field)) {
        const key = field.match(/^attachments\.\d+/)?.[0] as FieldKey;
        errors[key] = this.words.t('screenshotRefused');
      }
    }
    if (errors.name && !this.fields.has('name')) delete errors.name;
    if (errors.email && !this.fields.has('email')) delete errors.email;
    return errors;
  }

  // ------------------------------------------------------------------------------------------------------
  // Receipt

  showReceipt(receipt: Receipt): void {
    this.clearForm();
    this.revokeAll();
    const heading = h('h2', { class: 'receipt-title', tabindex: '-1' }, this.words.t('receiptTitle'));
    const code = h('span', { class: 'reference', id: 'wb-reference' }, receipt.reference);
    const status = h('p', { class: 'copy-status', role: 'status' });
    const copy = h(
      'button',
      { type: 'button', class: 'button secondary small', 'aria-describedby': 'wb-reference' },
      this.words.t('copy'),
    );
    copy.addEventListener('click', () => void this.copyReference(receipt.reference, code, status));
    const another = h(
      'button',
      { type: 'button', class: 'button secondary', onclick: () => this.startNewDraft(true) },
      this.words.t('sendAnother'),
    );
    this.setBody(
      'receipt',
      [
        h(
          'section',
          { class: 'receipt', 'aria-labelledby': 'wb-receipt-title' },
          h('div', { class: 'receipt-mark' }, icon([...ICONS.check], 22)),
          heading,
          h('p', { class: 'reference-label', id: 'wb-receipt-title' }, this.words.t('yourReference')),
          h('div', { class: 'reference-row' }, code, copy),
          h('p', { class: 'hint' }, this.words.t('referenceHint')),
          this.reportersOn && this.session
            ? h('p', { class: 'hint follow' }, this.words.t('followHint'))
            : null,
          status,
        ),
      ],
      [another, this.closeButton(true)],
    );
    this.live.textContent = this.words.t('reportSent', { reference: receipt.reference });
    heading.focus();
  }

  private async copyReference(reference: string, code: HTMLElement, status: HTMLElement): Promise<void> {
    let copied = false;
    // The frame is embedded with allow="" (FB-B03): where the browser says clipboard-write is off, don't even ask.
    const policy =
      (
        this.root.ownerDocument as Document & {
          permissionsPolicy?: { allowsFeature(feature: string): boolean };
          featurePolicy?: { allowsFeature(feature: string): boolean };
        }
      ).permissionsPolicy ??
      (this.root.ownerDocument as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
    const clipboardAllowed = !policy || policy.allowsFeature('clipboard-write');
    try {
      if (clipboardAllowed && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(reference);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      // The frame has no clipboard permission (allow=""): select it, then try the older command.
      const selection = this.root.ownerDocument.getSelection();
      const range = this.root.ownerDocument.createRange();
      range.selectNodeContents(code);
      selection?.removeAllRanges();
      selection?.addRange(range);
      try {
        copied = this.root.ownerDocument.execCommand?.('copy') ?? false;
      } catch {
        copied = false;
      }
    }
    status.textContent = copied ? this.words.t('copied') : this.words.t('copySelection');
  }

  // ------------------------------------------------------------------------------------------------------
  // Reporter sign-in (CT-162)

  /** Keeps a report sent while signed in, with its summary, for “Your reports” (control keeps no text). */
  private remember(receipt: Receipt): void {
    const session = this.reportersOn ? this.session : null;
    if (!session) return;
    const sent = session.sent.filter((s) => s.reference !== receipt.reference);
    sent.unshift({
      reference: receipt.reference,
      type: this.values.type,
      summary: reporterSummaryOf(this.values.description),
      at: receipt.receivedAt,
    });
    session.sent = sent.slice(0, SENT_MAX);
    if (this.config?.contactFields.name === 'optional') session.name = this.values.name.trim();
    this.persist();
  }

  private persist(): void {
    if (this.session) saveSession(this.opts.params.site, this.session);
  }

  /** “Signed in as {email} · Sign out” (the form's contact group and “Your reports”). */
  private signedInLine(): HTMLElement {
    return h(
      'p',
      { class: 'signed-in', id: 'wb-signed-in', tabindex: '-1' },
      h(
        'span',
        {},
        ...translatedParts(this.words.raw('signedInAs'), {
          email: h('span', { class: 'signed-in-email' }, this.session?.email ?? ''),
        }),
      ),
      h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'),
      h(
        'button',
        { type: 'button', class: 'link', onclick: () => void this.signOut() },
        this.words.t('signOut'),
      ),
    );
  }

  /** “New report”: the draft as it was, or a fresh one after a receipt. */
  showNewReport(): void {
    if (this.view === 'form' || this.view === 'receipt' || !this.config) return;
    if (this.receipt) this.startNewDraft(false);
    else this.showForm();
  }

  /** “Your reports”: the list when signed in, else the sign-in view. */
  showYourReports(): void {
    if (this.view === 'reports' || this.view === 'signin' || !this.reportersOn) return;
    if (this.session) void this.showReports();
    else this.showSignin('reports');
  }

  /** A labelled input with its error under it (`aria-invalid`, `aria-describedby` while shown). */
  private plainField(
    id: string,
    label: string,
    attrs: Record<string, string | boolean>,
    hint?: string,
  ): PlainField {
    const input = h('input', { id, name: id, class: 'input', ...attrs });
    const error = h('p', { id: `${id}-error`, class: 'error', hidden: true });
    const hintEl = hint ? h('p', { id: `${id}-hint`, class: 'hint' }, hint) : null;
    const describe = (withError: boolean) => {
      const ids = [hintEl?.id, withError ? error.id : null].filter(Boolean).join(' ');
      if (ids) input.setAttribute('aria-describedby', ids);
      else input.removeAttribute('aria-describedby');
    };
    describe(false);
    const setError = (message: string | null) => {
      error.textContent = message ?? '';
      error.hidden = !message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      describe(Boolean(message));
    };
    input.addEventListener('input', () => setError(null));
    const wrap = h(
      'div',
      { class: 'field' },
      h('label', { for: id, class: 'label' }, label),
      hintEl,
      input,
      error,
    );
    return { wrap, input, setError };
  }

  /**
   * The sign-in view: the address, then the code sent to it. `ret` is where a sign-in leads (the form it was asked
   * from, or “Your reports”); `message` an alert to show (an ended session).
   */
  showSignin(ret: 'form' | 'reports', message: string | null = null, step: 'email' | 'code' = 'email'): void {
    if (!this.config || !this.reportersOn) return;
    this.signinReturn = ret;
    this.signinStep = step;
    this.clearForm();
    this.alertBox = h('div', { class: 'alert', role: 'alert', hidden: true });
    const heading = h(
      'h2',
      { class: 'view-title', id: 'wb-signin-title', tabindex: '-1' },
      this.words.t('followReports'),
    );
    const form = h('form', {
      id: 'wb-signin',
      class: 'form signin',
      novalidate: true,
      'aria-labelledby': 'wb-signin-title',
    });
    const submit = h('button', { type: 'submit', class: 'button primary', form: 'wb-signin' }, '');
    const back = h(
      'button',
      { type: 'button', class: 'button secondary', onclick: () => this.leaveSignin() },
      this.words.t('back'),
    );
    if (step === 'email') {
      const email = this.plainField('wb-signin-email', this.words.t('email'), {
        type: 'email',
        autocomplete: 'email',
        spellcheck: 'false',
        'aria-required': 'true',
      });
      email.input.value = this.signinEmail || this.values.email.trim();
      submit.textContent = this.words.t('sendCode');
      form.append(heading, h('p', { class: 'lead' }, this.words.t('signInHint')), email.wrap);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.sendCode(email, submit, false);
      });
    } else {
      const code = this.plainField('wb-signin-code', this.words.t('code'), {
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        maxlength: '6',
        pattern: '[0-9]{6}',
        spellcheck: 'false',
        'aria-required': 'true',
      });
      code.input.classList.add('code-input');
      const resend = h(
        'button',
        { type: 'button', class: 'link', disabled: true },
        this.words.t('resendCode'),
      );
      const status = h('p', { class: 'hint signin-status', role: 'status' });
      resend.addEventListener('click', () => void this.sendCode(null, resend, true, status));
      this.armResend(resend);
      submit.textContent = this.words.t('signIn');
      form.append(
        heading,
        h(
          'p',
          { class: 'lead' },
          ...translatedParts(this.words.raw('enterCodeAt'), {
            email: h('span', { class: 'signed-in-email' }, this.signinEmail),
          }),
        ),
        code.wrap,
        h(
          'p',
          { class: 'link-row' },
          h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: () => {
                this.showSignin(this.signinReturn);
                this.body.querySelector<HTMLInputElement>('input')?.focus();
              },
            },
            this.words.t('differentEmail'),
          ),
          resend,
        ),
        status,
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.signIn(code, submit);
      });
    }
    this.setBody('signin', [form], [this.alertBox, back, submit]);
    if (message) this.showAlert(message);
  }

  /** “Send a new code” becomes available `FEEDBACK_REPORTER_RESEND_S` after the last code. */
  private armResend(button: HTMLButtonElement): void {
    clearTimeout(this.resendTimer);
    const wait = this.codeSentAt + FEEDBACK_REPORTER_RESEND_S * 1000 - Date.now();
    button.disabled = wait > 0;
    if (wait > 0)
      this.resendTimer = setTimeout(() => {
        button.disabled = false;
      }, wait);
  }

  /** Back from sign-in: the form (a sign-in from “Your reports” also returns there, nothing to list yet). */
  private leaveSignin(): void {
    this.showNewReport();
    const link = this.body.querySelector<HTMLElement>('#wb-signin-link');
    (link ?? this.tabNew).focus();
  }

  /** A route said 404: sign-in isn't offered here (any more). The session, if any, is forgotten. */
  private signinUnavailable(): void {
    this.reportersOff = true;
    if (this.session) {
      this.session = null;
      clearSession(this.opts.params.site);
    }
    this.updateTabs();
  }

  /** The alert of a failed reporter call (404 handled by the caller). */
  private reporterAlert(outcome: ReporterOutcome<unknown>, retry?: () => void): void {
    if (outcome.kind === 'rate_limited')
      this.showAlert(this.words.t('signInRateLimited', { retry: retryText(outcome.retryAfter, this.words) }));
    else if (outcome.kind === 'network')
      this.showAlert(
        this.words.t('connectionError'),
        retry && { label: this.words.t('tryAgain'), run: retry },
      );
    else
      this.showAlert(this.words.t('serverError'), retry && { label: this.words.t('tryAgain'), run: retry });
  }

  /** Asks for a code (the email step's submit, or “Send a new code”). */
  async sendCode(
    field: PlainField | null,
    button: HTMLButtonElement,
    resend: boolean,
    status: HTMLElement | null = null,
  ): Promise<void> {
    const email = normalizeReporterEmail(field ? field.input.value : this.signinEmail);
    if (field && (!email || email.length > 254 || !EMAIL.test(email))) {
      field.setError(this.words.t('emailInvalid'));
      field.input.focus();
      return;
    }
    this.showAlert(null);
    const label = button.textContent;
    button.disabled = true;
    if (!resend) button.textContent = this.words.t('sending');
    const outcome = await requestCode(this.opts.fetch, this.endpoints, {
      email,
      parent: this.opts.params.parent,
    });
    if (this.view !== 'signin') return;
    button.textContent = label;
    button.disabled = false;
    if (outcome.kind === 'ok') {
      this.signinEmail = email;
      this.codeSentAt = Date.now();
      if (resend) {
        // Only the newest code works (control and the runtime end the earlier one).
        this.armResend(button);
        if (status) status.textContent = this.words.t('resentCode');
        return;
      }
      this.showSignin(this.signinReturn, null, 'code');
      this.live.textContent = this.words.t('codeSentTo', { email });
      this.body.querySelector<HTMLInputElement>('#wb-signin-code')?.focus();
      return;
    }
    if (resend) this.armResend(button);
    if (outcome.kind === 'unavailable') {
      this.signinUnavailable();
      button.disabled = true;
      this.showAlert(this.words.t('signInUnavailable'));
    } else if (outcome.kind === 'invalid' && field) {
      field.setError(this.words.t('emailInvalid'));
      field.input.focus();
    } else this.reporterAlert(outcome);
  }

  /** Exchanges the code for a session, then goes where the sign-in was asked from. */
  async signIn(field: PlainField, button: HTMLButtonElement): Promise<void> {
    const code = field.input.value.replace(/\s+/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      field.setError(this.words.t('codeInvalid'));
      field.input.focus();
      return;
    }
    this.showAlert(null);
    button.disabled = true;
    button.textContent = this.words.t('signingIn');
    const outcome = await startSession(this.opts.fetch, this.endpoints, {
      email: this.signinEmail,
      code,
      parent: this.opts.params.parent,
    });
    if (this.view !== 'signin') return;
    button.disabled = false;
    button.textContent = this.words.t('signIn');
    if (outcome.kind === 'ok') {
      const name = this.config?.contactFields.name === 'optional' ? this.values.name.trim() : '';
      this.session = { ...outcome.value, name, sent: [] };
      this.persist();
      this.live.textContent = this.words.t('signedInStatus', { email: outcome.value.email });
      if (this.signinReturn === 'reports') {
        await this.showReports();
        this.body.querySelector<HTMLElement>('#wb-reports-title')?.focus();
      } else {
        this.showNewReport();
        this.body.querySelector<HTMLElement>('#wb-signed-in')?.focus();
      }
      return;
    }
    if (outcome.kind === 'code_refused') {
      field.setError(this.words.t('codeRefused'));
      field.input.focus();
    } else if (outcome.kind === 'unavailable') {
      this.signinUnavailable();
      button.disabled = true;
      this.showAlert(this.words.t('signInUnavailable'));
    } else this.reporterAlert(outcome);
  }

  /** Forgets the session here and ends it on the server (best effort). */
  async signOut(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearSession(this.opts.params.site);
    this.reportRows = null;
    this.live.textContent = this.words.t('signedOut');
    if (this.view === 'reports') {
      this.showSignin('reports');
      this.body.querySelector<HTMLInputElement>('input')?.focus();
    } else if (this.view === 'form') {
      this.showForm();
      this.body.querySelector<HTMLElement>('#wb-signin-link')?.focus();
    }
    await endSession(this.opts.fetch, this.endpoints, session.token);
  }

  /** “Your reports”: the list, loaded from the server (the last one shown meanwhile). */
  async showReports(): Promise<void> {
    if (!this.session || !this.config) return;
    this.clearForm();
    this.alertBox = h('div', { class: 'alert', role: 'alert', hidden: true });
    const list = h('div', { class: 'reports', id: 'wb-reports' });
    const refresh = h(
      'button',
      { type: 'button', class: 'button secondary', onclick: () => void this.loadReports(list, true) },
      this.words.t('refresh'),
    );
    this.setBody(
      'reports',
      [
        h(
          'section',
          { class: 'reports-view', 'aria-labelledby': 'wb-reports-title' },
          h('h2', { class: 'sr-only', id: 'wb-reports-title', tabindex: '-1' }, this.words.t('yourReports')),
          this.signedInLine(),
          list,
        ),
      ],
      [this.alertBox, refresh, this.closeButton(true)],
    );
    await this.loadReports(list, false);
  }

  private async loadReports(list: HTMLElement, announce: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    const seq = ++this.reportsSeq;
    this.showAlert(null);
    list.setAttribute('aria-busy', 'true');
    if (!this.reportRows) list.replaceChildren(h('p', { class: 'loading' }, this.words.t('loadingReports')));
    else this.renderReports(list);
    const outcome = await fetchReports(this.opts.fetch, this.endpoints, session.token);
    if (seq !== this.reportsSeq || this.view !== 'reports') return;
    list.removeAttribute('aria-busy');
    if (outcome.kind === 'ok') {
      this.reportRows = mergeReports(outcome.value, session.sent, Date.now());
      this.renderReports(list);
      if (announce) this.live.textContent = this.words.t('reportsRefreshed');
      return;
    }
    if (outcome.kind === 'signed_out') {
      this.session = null;
      this.reportRows = null;
      clearSession(this.opts.params.site);
      this.showSignin('reports', this.words.t('sessionEnded'));
      this.body.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    if (!this.reportRows) list.replaceChildren();
    const retry = () => void this.loadReports(list, true);
    // 404: the site's sign-in or drop is off for now (control); the session is kept for when it's back.
    if (outcome.kind === 'unavailable')
      this.showAlert(this.words.t('reportsUnavailable'), { label: this.words.t('tryAgain'), run: retry });
    else this.reporterAlert(outcome, retry);
  }

  private renderReports(list: HTMLElement): void {
    const rows = this.reportRows ?? [];
    if (rows.length === 0) {
      list.replaceChildren(h('p', { class: 'empty' }, this.words.t('noReports')));
      return;
    }
    const now = new Date();
    list.replaceChildren(
      h(
        'ul',
        { class: 'report-list', 'aria-label': this.words.t('yourReports') },
        ...rows.map((row) =>
          h(
            'li',
            { class: 'report' },
            h(
              'p',
              { class: 'report-top' },
              h(
                'span',
                { class: 'report-type' },
                this.words.t(row.type === 'bug' ? 'reportTypeProblem' : 'reportTypeIdea'),
              ),
              h('span', { class: 'report-ref' }, row.reference),
              h('span', { class: 'report-date' }, formatDay(row.receivedAt, now, this.words.locale)),
            ),
            row.summary ? h('p', { class: 'report-summary' }, row.summary) : null,
            h(
              'p',
              { class: 'report-status', 'data-status': row.status },
              reportStatusText(row.type, row.status, this.words),
            ),
          ),
        ),
      ),
    );
  }

  /** A new, empty draft with a new submission id (after a receipt, or when opened again after one). */
  startNewDraft(focus: boolean): void {
    if (!this.config) return;
    this.revokeAll();
    this.submitter.newDraft();
    this.receipt = null;
    this.values = emptyDraft(this.values.type);
    // Signed in, the name is remembered (the email is the session's).
    if (this.reportersOn && this.session && this.config.contactFields.name === 'optional')
      this.values.name = this.session.name;
    this.focusWhenReady = focus;
    this.showForm();
  }

  /** Where focus goes when the panel opens or a view appears. */
  private focusStart(): void {
    if (!this.focusWhenReady) return;
    if (this.view === 'loading') return;
    this.focusWhenReady = false;
    if (this.view === 'form') {
      const first =
        this.typeInputs.get(this.values.type) ?? (this.fields.get('description')?.control as HTMLElement);
      first?.focus();
    } else if (this.view === 'receipt') {
      this.body.querySelector<HTMLElement>('.receipt-title')?.focus();
    } else if (this.view === 'signin') {
      this.body.querySelector<HTMLElement>('input')?.focus();
    } else if (this.view === 'reports') {
      this.body.querySelector<HTMLElement>('#wb-reports-title')?.focus();
    } else {
      this.foot.querySelector<HTMLElement>('button')?.focus();
    }
  }
}

export function applyFrameLanguage(doc: Document, lang: string, words: WidgetTranslator): void {
  doc.documentElement.lang = lang;
  doc.title = words.t('frameTitle');
}

/** Sets `data-theme` on `<html>`: fixed, or following `prefers-color-scheme` for `auto`. */
export function applyTheme(doc: Document, theme: FrameParams['theme']): void {
  const html = doc.documentElement;
  if (theme !== 'auto') {
    html.dataset.theme = theme;
    return;
  }
  const query = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  const set = () => {
    html.dataset.theme = query?.matches ? 'dark' : 'light';
  };
  set();
  query?.addEventListener?.('change', set);
}
