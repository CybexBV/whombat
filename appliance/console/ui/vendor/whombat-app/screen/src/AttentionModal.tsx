/**
 * `<AttentionModal>` (DK-135, DK-136): outages and questions over the dashboard, in the planner's order — what, since
 * when, what it means and its step, *Not now*, and “1 of 3” with arrows. It opens by itself for what pops and wasn't put
 * away (so again only for something new) and closes itself when what it shows is resolved; the pill opens it with
 * everything. The answers to a question are the host's: the box's console gives the question's own words and answers
 * (`askView`, DK-151), a screen elsewhere says to answer on the phone or at Whombat.
 */
import type { ReactNode } from 'react';
import { type ModalState, type ModalView, modalStep, modalView, notNow } from './attention';
import { screenFormatLocale } from './i18n/catalog';
import { cx, EnvProvider, Face, type ScreenEnv, useScreenWords } from './parts';
import st from './screen.module.css';
import type { DeskAttention, DeskAttentionItem } from './types';
import { agoText, clockText, fillWords, screenWords } from './words';

/** One of a question's own answers as the host gives it (DK-151). */
export interface AskButton {
  key: string;
  label: string;
  /** The question's main answer: drawn filled. */
  primary?: boolean | undefined;
  /** It asks for the PIN first: drawn with a lock. */
  lock?: boolean | undefined;
  onPress: () => void;
}

/**
 * A question as a host that knows it gives it (DK-151): the assistant's question and what happens (`quote`), the command
 * or the target (`facts`), who asks when it isn't the assistant (`from`), its own answers, a line under them (why the
 * phone, the PIN, what went wrong) and whether an answer is on its way (`busy`: the buttons wait).
 */
export interface AskView {
  quote?: string | undefined;
  facts?: readonly string[] | undefined;
  from?: string | undefined;
  buttons: readonly AskButton[];
  note?: { text: string; icon?: 'lock' | 'phone' | undefined } | undefined;
  busy?: boolean | undefined;
}

export interface AttentionActions {
  /** A question's own words and answers (DK-151); wins over `renderAsk` and `onAnswer`. Null: as without it. */
  askView?: ((item: DeskAttentionItem) => AskView | null) | undefined;
  /** A question's answers (the box's console: its ask card, the PIN first while locked). */
  onAnswer?: ((ask: number, item: DeskAttentionItem) => void) | undefined;
  /** Draws a question's own buttons instead of *Answer* (a host that knows the ask's choices). */
  renderAsk?: ((item: DeskAttentionItem) => ReactNode) | undefined;
  /** *Ask {assistant} to fix it* on a problem nobody looked into yet. */
  onFix?: ((item: DeskAttentionItem) => void) | undefined;
  /** The step the assistant offers once it looked into it (`fix`, the go-ahead). */
  onStep?: ((item: DeskAttentionItem) => void) | undefined;
  /** *Open {name}*: the server's or the thing's own screen. */
  onOpen?: ((item: DeskAttentionItem) => void) | undefined;
  /** A screen elsewhere (DK-138): it never answers or takes a step, it says where to. */
  answerElsewhere?: boolean | undefined;
  /** Locked: answering, a step and *Open* ask for the PIN first, and the modal says so. */
  locked?: boolean | undefined;
}

export interface AttentionModalProps extends AttentionActions {
  attention: DeskAttention;
  /** The keys put away with *Not now* (the host keeps them). */
  away: ReadonlySet<string>;
  state: ModalState;
  onState: (state: ModalState) => void;
  /** *Not now*: these keys go away until something new pops. */
  onAway: (keys: string[]) => void;
  now: number;
  /** The modal's width in the screen's pixels. */
  width: number;
  /** The screen's context (the assistant's name and face, the time zone); `<Screen>` gives it. */
  env?: ScreenEnv | undefined;
}

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={back ? 'M9 2L4 7l5 5' : 'M5 2l5 5-5 5'} />
    </svg>
  );
}

export function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 18) / 16}
      viewBox="0 0 16 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="1.5" y="7.5" width="13" height="9" rx="2.5" />
      <path d="M4.5 7.5V5a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
}

function PhoneIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={(size * 12) / 18}
      height={size}
      viewBox="0 0 12 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="10" height="16" rx="2.5" />
      <path d="M5 14h2" strokeLinecap="round" />
    </svg>
  );
}

/** A question's own answers (DK-151), then *Not now*, and its line under them. */
function AskButtons({ view, onNotNow }: { view: AskView; onNotNow: () => void }) {
  const words = useScreenWords().modal;
  const wait = view.busy === true;
  const press = (f: () => void) => () => {
    if (!wait) f();
  };
  return (
    <>
      <div className={st.mdButtons}>
        {view.buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            className={cx(st.btn, b.primary ? st.primary : st.outline, st.focus)}
            aria-disabled={wait || undefined}
            data-busy={wait || undefined}
            onClick={press(b.onPress)}
          >
            {b.lock && (
              <span className={st.btnLock}>
                <LockIcon size={15} />
              </span>
            )}
            {b.label}
          </button>
        ))}
        <button type="button" className={cx(st.btn, st.quiet, st.focus)} onClick={onNotNow}>
          {words.notNow}
        </button>
      </div>
      {view.note && (
        <div className={st.mdNote}>
          {view.note.icon === 'lock' && <LockIcon />}
          {view.note.icon === 'phone' && <PhoneIcon />}
          {view.note.text}
        </div>
      )}
    </>
  );
}

function Buttons({
  item,
  assistant,
  actions,
  onNotNow,
}: {
  item: DeskAttentionItem;
  assistant: string;
  actions: AttentionActions;
  onNotNow: () => void;
}) {
  const words = useScreenWords().modal;
  const elsewhere = !!actions.answerElsewhere;
  const out: ReactNode[] = [];
  let note: string | null = null;
  let acts = false;
  if (item.kind === 'ask') {
    if (elsewhere) note = words.elsewhereAsk;
    else if (actions.renderAsk) {
      out.push(<span key="ask">{actions.renderAsk(item)}</span>);
      acts = true;
    } else if (actions.onAnswer && item.ask !== undefined) {
      const ask = item.ask;
      out.push(
        <button
          key="answer"
          type="button"
          className={cx(st.btn, st.primary, st.focus)}
          onClick={() => actions.onAnswer?.(ask, item)}
        >
          {words.answer}
        </button>,
      );
      acts = true;
    }
  } else {
    const stage = item.research && item.research !== 'failed' ? item.research : null;
    if (elsewhere) note = words.elsewhereLook;
    else if (stage === 'found' && item.fix && actions.onStep) {
      out.push(
        <button
          key="step"
          type="button"
          className={cx(st.btn, st.primary, st.focus)}
          onClick={() => actions.onStep?.(item)}
        >
          {item.fix}
        </button>,
      );
      acts = true;
    } else if (!stage && actions.onFix) {
      out.push(
        <button
          key="fix"
          type="button"
          className={cx(st.btn, st.primary, st.focus)}
          onClick={() => actions.onFix?.(item)}
        >
          {fillWords(words.fix, { assistant })}
        </button>,
      );
    }
    if (item.name && actions.onOpen && stage !== 'fixed') {
      out.push(
        <button
          key="open"
          type="button"
          className={cx(st.btn, st.focus)}
          onClick={() => actions.onOpen?.(item)}
        >
          {fillWords(words.open, { name: item.name })}
        </button>,
      );
      acts = true;
    }
  }
  out.push(
    <button key="notnow" type="button" className={cx(st.btn, st.quiet, st.focus)} onClick={onNotNow}>
      {words.notNow}
    </button>,
  );
  if (!note && acts && actions.locked) note = words.pin;
  return (
    <>
      <div className={st.mdButtons}>{out}</div>
      {note && (
        <div className={st.mdNote}>
          {actions.locked && !elsewhere && <LockIcon />}
          {note}
        </div>
      )}
    </>
  );
}

function Top({
  item,
  view,
  now,
  env,
  from,
  onState,
}: {
  item: DeskAttentionItem;
  view: ModalView;
  now: number;
  env: ScreenEnv;
  /** Who asks, when it isn't the assistant. */
  from?: string | undefined;
  onState: (s: ModalState) => void;
}) {
  const words = screenWords(env.locale).modal;
  const since = item.since ? Date.parse(item.since) : Number.NaN;
  const clock = Number.isFinite(since) ? clockText(since, env.timeZone, env.locale) : null;
  const n = view.items.length;
  return (
    <div className={st.mdTop}>
      {item.kind === 'ask' ? (
        <span className={st.mdAsks}>
          {!from && <Face size={30} />}
          {clock
            ? fillWords(words.asks, { assistant: from ?? env.assistant, clock })
            : (from ?? env.assistant)}
        </span>
      ) : (
        <span className={st.mdSince}>
          {clock ? fillWords(words.since, { clock, ago: agoText(since, now, env.locale) }) : item.name}
        </span>
      )}
      {n > 1 && (
        <span className={st.mdCount}>
          {view.index > 0 && (
            <button
              type="button"
              className={cx(st.arrow, st.focus)}
              aria-label={words.previous}
              onClick={() => onState(modalStep(view, -1))}
            >
              <Chevron back />
            </button>
          )}
          {fillWords(words.of, { i: view.index + 1, n })}
          {view.index < n - 1 && (
            <button
              type="button"
              className={cx(st.arrow, st.focus)}
              aria-label={words.next}
              onClick={() => onState(modalStep(view, 1))}
            >
              <Chevron />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function AttentionModal(props: AttentionModalProps) {
  const view = modalView(props.attention, props.away, props.state);
  const item = view.item;
  if (!view.open || !item) return null;
  const env = props.env ?? { assistant: 'Dusty', editing: false };
  const lang = env.locale ? screenFormatLocale(env.locale) : undefined;
  const words = screenWords(env.locale).modal;
  const putAway = () => {
    const out = notNow(view);
    props.onAway(out.away);
    props.onState(out.state);
  };
  // A screen elsewhere never answers (DK-138): its question keeps saying where to.
  const ask = item.kind === 'ask' && !props.answerElsewhere ? (props.askView?.(item) ?? null) : null;
  const stage = item.kind === 'look' && item.research && item.research !== 'failed' ? item.research : null;
  const says =
    stage === 'looking'
      ? words.looking
      : stage === 'fixing'
        ? words.fixing
        : stage === 'fixed'
          ? words.fixed
          : null;
  return (
    <EnvProvider value={env}>
      {/* The backdrop closes what the pill opened; what opened by itself waits for an answer or *Not now*. */}
      <button
        type="button"
        className={st.ov}
        lang={lang}
        aria-label={words.close}
        tabIndex={-1}
        onClick={view.mode === 'all' ? () => props.onState({ pill: false, shown: null }) : undefined}
      />
      <section
        className={st.md}
        role="dialog"
        lang={lang}
        aria-modal="true"
        aria-label={item.title}
        data-kind={item.kind}
        data-tone={stage === 'fixed' ? 'ok' : item.tone}
        style={{ width: props.width }}
      >
        <Top item={item} view={view} now={props.now} env={env} from={ask?.from} onState={props.onState} />
        <h2 className={st.mdTitle}>{item.title}</h2>
        {item.kind === 'ask'
          ? (ask?.quote ?? item.detail) && <p className={st.mdQuote}>{ask?.quote ?? item.detail}</p>
          : item.detail && <p className={st.mdDetail}>{item.detail}</p>}
        {ask?.facts && ask.facts.length > 0 && (
          <ul className={st.mdFacts}>
            {ask.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        {says && (
          <p className={st.mdSays}>
            <Face size={30} />
            {fillWords(says, { assistant: env.assistant })}
          </p>
        )}
        {ask ? (
          <AskButtons view={ask} onNotNow={putAway} />
        ) : (
          <Buttons item={item} assistant={env.assistant} actions={props} onNotNow={putAway} />
        )}
      </section>
    </EnvProvider>
  );
}
