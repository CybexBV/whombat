/**
 * What answers in Chat, in words (0.96, CT-463…CT-465; Whombat chat-runtime.md CR-01…CR-09): the composer's button and
 * its popover or sheet, the usage line, what answered a reply, the divider when that changed, and the quiet lines when
 * fast replies or the model asked for didn't happen.
 */
import type { ChatProvider, ChatRuntime, ChatRuntimeProvider, RanOn } from '../domain/chat-runtime.js';
import { type FastSkippedReason, modelOf, type ProviderModel } from '../domain/models.js';
import { coreTranslator, coreWords } from '../i18n/catalog.js';
import { effortLabel } from './models.js';

const CHAT_PROVIDERS: readonly ChatProvider[] = ['claude', 'codex', 'local'];

/** Provider names in a locale (the custom model is “Custom”, “Eigen”). */
export function chatProviderLabels(locale?: string | null): Readonly<Record<ChatProvider, string>> {
  return coreWords(locale, 'chat.provider', CHAT_PROVIDERS);
}

/**
 * Providers named for the sign-in, with the Claude and OpenAI marks; the custom OpenAI-compatible AI model (`local`) is
 * “Custom”, its model by the name the person gave it (`localModelName`).
 */
export const CHAT_PROVIDER_LABELS: Readonly<Record<ChatProvider, string>> = chatProviderLabels('en');

/** The popover's and sheet's words, in a locale. */
export function chatRuntimeCopy(locale?: string | null) {
  const tr = coreTranslator(locale);
  return {
    /** The two-way switch's title: “Neo answers with”. */
    answersWith: (name: string) => tr.t('chat.answersWith', { name }),
    model: tr.t('chat.model'),
    effort: tr.t('chat.effort'),
    effortHint: tr.t('chat.effortHint'),
    fast: tr.t('chat.fast'),
    /** Fast replies exist only on Claude and ChatGPT models (`local` models have none). */
    fastHint: {
      claude: tr.t('chat.fastHint.claude'),
      codex: tr.t('chat.fastHint.codex'),
    } satisfies Readonly<Record<Exclude<ChatProvider, 'local'>, string>>,
    /** Under Fast replies when turning it on in a Claude thread that has replies. */
    fastMidThread: tr.t('chat.fastMidThread'),
    fastGateway: tr.t('chat.fastGateway'),
    scopeThread: tr.t('chat.scopeThread'),
    scopeNext: tr.t('chat.scopeNext'),
    makeDefault: (name: string) => tr.t('chat.makeDefault', { name }),
    /** The tag on the tool's default model. */
    defaultTag: tr.t('chat.defaultTag'),
    /** Opens the rest of the models in place: “3 more…”. */
    more: (n: number) => tr.t('chat.more', { n }),
    notSetUp: (label: string) => tr.t('chat.notSetUp', { label }),
    setUp: tr.t('chat.setUp'),
    /** The toast after “Make this Neo’s default”: “Neo now answers with Opus · High by default.” */
    madeDefault: (name: string, choice: string) => tr.t('chat.madeDefault', { name, choice }),
    /** The button's aria-label. */
    buttonLabel: (name: string) => tr.t('chat.buttonLabel', { name }),
    /** No AI signed in yet (Set up your AI skipped): the button says so and leads to signing one in. */
    noAi: tr.t('chat.noAi'),
    noAiLabel: (name: string) => tr.t('chat.noAiLabel', { name }),
  };
}

export type ChatRuntimeCopy = ReturnType<typeof chatRuntimeCopy>;

/** The popover's and sheet's words (CR-01, CR-04, CR-05, CR-06). */
export const CHAT_RUNTIME_COPY: ChatRuntimeCopy = chatRuntimeCopy('en');

/** A model by its own label (“Opus”, never “Default (Opus)”): the named one, else the tool's default; else its id. */
export function chatModelLabel(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
  locale?: string | null,
): string {
  return modelOf(models, id)?.label ?? id ?? coreTranslator(locale).t('model.defaultModel');
}

/** “Opus”, “Opus and Fable”, “Opus, Fable and Sonnet”. */
function listOf(names: readonly string[], locale?: string | null): string {
  if (names.length <= 1) return names[0] ?? '';
  return coreTranslator(locale).t('chat.list', {
    items: names.slice(0, -1).join(', '),
    last: names[names.length - 1] ?? '',
  });
}

/**
 * Under Fast replies when the picked model has none (CR-06): “Only Opus has fast replies. Sonnet is picked.”; “This
 * model has no fast replies.” when no model of the list has them.
 */
export function fastNoneText(
  models: readonly ProviderModel[] | null | undefined,
  pickedId: string | null | undefined,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const fast = (models ?? []).filter((m) => m.fast).map((m) => m.label);
  if (fast.length === 0) return tr.t('chat.noFast');
  return tr.tp('chat.onlyFast', fast.length, {
    models: listOf(fast, locale),
    picked: chatModelLabel(models, pickedId, locale),
  });
}

/**
 * The popover's usage line (CR-09): “This 5 hours: Claude 38% used · ChatGPT 12% used”, whole percents; a provider
 * without a known window is left out; null when none is known.
 */
export function chatUsageLine(
  providers: readonly Pick<ChatRuntimeProvider, 'provider' | 'usage'>[],
  locale?: string | null,
): string | null {
  const tr = coreTranslator(locale);
  const parts = providers.flatMap((p) =>
    p.usage
      ? [
          tr.t('chat.usagePart', {
            provider: tr.t(`chat.provider.${p.provider}`),
            pct: Math.round(p.usage.usedPct),
          }),
        ]
      : [],
  );
  return parts.length ? tr.t('chat.usageLine', { parts: parts.join(' · ') }) : null;
}

/**
 * The composer's button (CR-01): `label` “Opus · Automatic”, “GPT-6.1 Sol · High”; `fast` shows the bolt — the
 * choice's own, else the model's default, never for a model the list says has none.
 */
export function chatRuntimeChip(
  runtime: ChatRuntime,
  models: readonly ProviderModel[] | null | undefined,
  locale?: string | null,
): { label: string; fast: boolean } {
  const model = modelOf(models, runtime.model);
  const label = `${chatModelLabel(models, runtime.model, locale)} · ${effortLabel(runtime.effort, locale)}`;
  const fast = model && !model.fast ? false : (runtime.fast ?? model?.fast === 'on');
  return { label, fast };
}

/** What answered a reply, on hover or long-press (CR-07): “Claude · Opus · High effort · Fast”. */
export function ranOnText(ranOn: RanOn, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const parts = [tr.t(`chat.provider.${ranOn.provider}`)];
  if (ranOn.modelLabel) parts.push(ranOn.modelLabel);
  if (ranOn.effort) parts.push(tr.t('model.effortWords', { effort: tr.t(`effort.${ranOn.effort}`) }));
  if (ranOn.fast) parts.push(tr.t('model.fast'));
  return parts.join(' · ');
}

/** What a reply asked for: a skipped model or fast reply counts as asked, its own quiet line says what happened. */
function askedOf(r: RanOn) {
  return { model: r.modelSkipped ?? r.model, fast: r.fast || !!r.fastSkipped };
}

/**
 * The divider before a reply that ran on something else than the thread's previous reply (CR-07): “Switched to ChatGPT ·
 * High effort”, “Switched to Sonnet · fast replies off”, “Fast replies on” alone. Null for the first reply and when
 * nothing asked for changed (a skipped model or fast reply has its own line, `modelSkippedText`, `fastSkippedText`).
 */
export function runSwitchText(
  prev: RanOn | null | undefined,
  next: RanOn,
  locale?: string | null,
): string | null {
  if (!prev) return null;
  const tr = coreTranslator(locale);
  const was = askedOf(prev);
  const now = askedOf(next);
  const parts: string[] = [];
  if (prev.provider !== next.provider) parts.push(tr.t(`chat.provider.${next.provider}`));
  else if (was.model !== now.model && !next.modelSkipped) {
    const label = next.modelLabel ?? next.model;
    if (label) parts.push(label);
  }
  if (prev.effort !== next.effort && next.effort)
    parts.push(tr.t('model.effortWords', { effort: tr.t(`effort.${next.effort}`) }));
  if (was.fast !== now.fast) {
    if (parts.length === 0) return tr.t(now.fast ? 'chat.fastOn' : 'chat.fastOff');
    parts.push(tr.t(now.fast ? 'chat.fastOnLower' : 'chat.fastOffLower'));
  }
  return parts.length ? tr.t('chat.switchedTo', { what: parts.join(' · ') }) : null;
}

/** Under a reply that asked for fast replies and came at the normal speed (CR-08). */
export function fastSkippedText(
  reason: FastSkippedReason,
  provider: ChatProvider,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  switch (reason) {
    case 'busy':
      return tr.t('chat.skipped.busy');
    case 'credits':
      return tr.t(provider === 'codex' ? 'chat.skipped.creditsCodex' : 'chat.skipped.creditsClaude');
    case 'org':
      return tr.t(provider === 'codex' ? 'chat.skipped.orgCodex' : 'chat.skipped.orgClaude');
    case 'unavailable':
      return tr.t('chat.skipped.unavailable');
  }
}

/** Under a reply whose model wasn't available (CR-08): “Fable wasn’t available, so this one came from Opus.” */
export function modelSkippedText(askedLabel: string, usedLabel: string, locale?: string | null): string {
  return coreTranslator(locale).t('chat.modelSkipped', { asked: askedLabel, used: usedLabel });
}
