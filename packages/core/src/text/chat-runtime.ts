/**
 * What answers in Chat, in words (0.96, CT-463…CT-465; Whombat chat-runtime.md CR-01…CR-09): the composer's button and
 * its popover or sheet, the usage line, what answered a reply, the divider when that changed, and the quiet lines when
 * fast replies or the model asked for didn't happen.
 */
import type { ChatProvider, ChatRuntime, ChatRuntimeProvider, RanOn } from '../domain/chat-runtime.js';
import { type FastSkippedReason, modelOf, type ProviderModel } from '../domain/models.js';
import { EFFORT_LABELS, effortLabel, MODEL_EFFORT_COPY } from './models.js';

/**
 * Providers named for the sign-in, with the Claude and OpenAI marks; the custom OpenAI-compatible AI model (`local`) is
 * “Custom”, its model by the name the person gave it (`localModelName`).
 */
export const CHAT_PROVIDER_LABELS: Readonly<Record<ChatProvider, string>> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  local: 'Custom',
};

/** The popover's and sheet's words (CR-01, CR-04, CR-05, CR-06). */
export const CHAT_RUNTIME_COPY = {
  /** The two-way switch's title: “Neo answers with”. */
  answersWith: (name: string) => `${name} answers with`,
  model: 'Model',
  effort: 'Effort',
  effortHint: 'Higher thinks longer: slower replies and more usage.',
  fast: 'Fast replies',
  /** Fast replies exist only on Claude and ChatGPT models (`local` models have none, CT-1173). */
  fastHint: {
    claude: 'Up to 2½× faster. Paid from usage credits on your Claude account, not from your plan.',
    codex: 'About twice as fast. Uses up your ChatGPT plan quicker.',
  } satisfies Readonly<Record<Exclude<ChatProvider, 'local'>, string>>,
  /** Under Fast replies when turning it on in a Claude thread that has replies. */
  fastMidThread: 'Turning it on now reads this whole thread once at the fast price.',
  fastGateway: 'Fast replies don’t go through the AI gateway.',
  scopeThread: 'For this thread',
  scopeNext: 'For your next question',
  makeDefault: (name: string) => `Make this ${name}’s default`,
  /** The tag on the tool's default model. */
  defaultTag: 'DEFAULT',
  /** Opens the rest of the models in place: “3 more…”. */
  more: (n: number) => `${n} more…`,
  notSetUp: (label: string) => `${label} isn’t set up on this Whombat.`,
  setUp: 'Set it up',
  /** The toast after “Make this Neo’s default”: “Neo now answers with Opus · High by default.” */
  madeDefault: (name: string, choice: string) => `${name} now answers with ${choice} by default.`,
  /** The button's aria-label. */
  buttonLabel: (name: string) => `Choose how ${name} answers`,
} as const;

/** A model by its own label (“Opus”, never “Default (Opus)”): the named one, else the tool's default; else its id. */
export function chatModelLabel(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
): string {
  return modelOf(models, id)?.label ?? id ?? MODEL_EFFORT_COPY.defaultModel;
}

/** “Opus”, “Opus and Fable”, “Opus, Fable and Sonnet”. */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Under Fast replies when the picked model has none (CR-06): “Only Opus has fast replies. Sonnet is picked.”; “This
 * model has no fast replies.” when no model of the list has them.
 */
export function fastNoneText(
  models: readonly ProviderModel[] | null | undefined,
  pickedId: string | null | undefined,
): string {
  const fast = (models ?? []).filter((m) => m.fast).map((m) => m.label);
  if (fast.length === 0) return 'This model has no fast replies.';
  const verb = fast.length === 1 ? 'has' : 'have';
  return `Only ${listOf(fast)} ${verb} fast replies. ${chatModelLabel(models, pickedId)} is picked.`;
}

/**
 * The popover's usage line (CR-09): “This 5 hours: Claude 38% used · ChatGPT 12% used”, whole percents; a provider
 * without a known window is left out; null when none is known.
 */
export function chatUsageLine(
  providers: readonly Pick<ChatRuntimeProvider, 'provider' | 'usage'>[],
): string | null {
  const parts = providers.flatMap((p) =>
    p.usage ? [`${CHAT_PROVIDER_LABELS[p.provider]} ${Math.round(p.usage.usedPct)}% used`] : [],
  );
  return parts.length ? `This 5 hours: ${parts.join(' · ')}` : null;
}

/**
 * The composer's button (CR-01): `label` “Opus · Automatic”, “GPT-6.1 Sol · High”; `fast` shows the bolt — the
 * choice's own, else the model's default, never for a model the list says has none.
 */
export function chatRuntimeChip(
  runtime: ChatRuntime,
  models: readonly ProviderModel[] | null | undefined,
): { label: string; fast: boolean } {
  const model = modelOf(models, runtime.model);
  const label = `${chatModelLabel(models, runtime.model)} · ${effortLabel(runtime.effort)}`;
  const fast = model && !model.fast ? false : (runtime.fast ?? model?.fast === 'on');
  return { label, fast };
}

/** What answered a reply, on hover or long-press (CR-07): “Claude · Opus · High effort · Fast”. */
export function ranOnText(ranOn: RanOn): string {
  const parts = [CHAT_PROVIDER_LABELS[ranOn.provider]];
  if (ranOn.modelLabel) parts.push(ranOn.modelLabel);
  if (ranOn.effort) parts.push(`${EFFORT_LABELS[ranOn.effort]} effort`);
  if (ranOn.fast) parts.push('Fast');
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
export function runSwitchText(prev: RanOn | null | undefined, next: RanOn): string | null {
  if (!prev) return null;
  const was = askedOf(prev);
  const now = askedOf(next);
  const parts: string[] = [];
  if (prev.provider !== next.provider) parts.push(CHAT_PROVIDER_LABELS[next.provider]);
  else if (was.model !== now.model && !next.modelSkipped) {
    const label = next.modelLabel ?? next.model;
    if (label) parts.push(label);
  }
  if (prev.effort !== next.effort && next.effort) parts.push(`${EFFORT_LABELS[next.effort]} effort`);
  if (was.fast !== now.fast) {
    if (parts.length === 0) return now.fast ? 'Fast replies on' : 'Fast replies off';
    parts.push(now.fast ? 'fast replies on' : 'fast replies off');
  }
  return parts.length ? `Switched to ${parts.join(' · ')}` : null;
}

const NORMAL_SPEED = 'so this one came at the normal speed.';

/** Under a reply that asked for fast replies and came at the normal speed (CR-08). */
export function fastSkippedText(reason: FastSkippedReason, provider: ChatProvider): string {
  switch (reason) {
    case 'busy':
      return `Fast replies were busy, ${NORMAL_SPEED}`;
    case 'credits':
      return provider === 'codex'
        ? `Fast replies need more usage on your ChatGPT plan, ${NORMAL_SPEED}`
        : `Fast replies need usage credits on your Claude account, ${NORMAL_SPEED}`;
    case 'org':
      return `Fast replies are turned off for your ${provider === 'codex' ? 'ChatGPT workspace' : 'Claude organization'}, ${NORMAL_SPEED}`;
    case 'unavailable':
      return `Fast replies weren’t available, ${NORMAL_SPEED}`;
  }
}

/** Under a reply whose model wasn't available (CR-08): “Fable wasn’t available, so this one came from Opus.” */
export function modelSkippedText(askedLabel: string, usedLabel: string): string {
  return `${askedLabel} wasn’t available, so this one came from ${usedLabel}.`;
}
