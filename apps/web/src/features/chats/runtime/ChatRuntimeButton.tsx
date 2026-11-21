import { Link } from '@tanstack/react-router';
import { BrandMark } from '@whombat/brand/react';
import {
  type ChatThreadState,
  chatDraftWithEffort,
  chatDraftWithFast,
  chatDraftWithModel,
  chatDraftWithProvider,
  chatEffortChoices,
  chatFastRow,
  chatMakeDefaultShown,
  chatModelRows,
  chatModelsOf,
  chatProviderHints,
  chatProviderOf,
  chatProviderSegments,
  chatRuntimeButton,
  chatRuntimeLine,
  chatRuntimeScope,
} from '@whombat/client';
import type { ChatProvider, ChatRuntime, ChatRuntimeView } from '@whombat/core';
import { CHAT_RUNTIME_COPY } from '@whombat/core/text';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Toggle } from '../../../components/Toggle';
import { AnotherModel } from '../../agent/AnotherModel';
import styles from './ChatRuntime.module.css';

/**
 * The provider's mark (CR-04): Claude's, OpenAI's for ChatGPT (drawn in the text colour), and a server for Local, the
 * model on your network (hermes-engine-app.md AP-5044; no company's mark to show).
 */
export function ProviderMark({ provider, size }: { provider: ChatProvider; size: number }) {
  if (provider === 'local') return <Icon name="localModel" size={size} />;
  return <BrandMark mark={provider === 'claude' ? 'claude' : 'openai'} size={size} />;
}

/** The bolt of fast replies (the mock's filled lightning). Decorative. */
export function Bolt({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" />
    </svg>
  );
}

export interface ChatRuntimeButtonProps {
  view: ChatRuntimeView;
  /** The choice in effect (`chatRuntimeInEffect`). */
  runtime: ChatRuntime;
  /** A thread's reply box (“For this thread”), or the top-level box (“For your next question”). */
  inThread: boolean;
  /** In a thread: its replies, for Fast replies' note on Claude. */
  threadState?: ChatThreadState | null;
  onChange: (next: ChatRuntime) => void;
  /** “Make this <Name>’s default”; resolves when it is done. */
  onMakeDefault?: (runtime: ChatRuntime) => void;
  /** “Set it up”: where people sign in to a provider. */
  setUpHref?: { to: string; search?: Record<string, unknown> };
}

const GAP = 8;
const WIDTH = 345;

/**
 * What answers in Chat (Whombat chat-runtime.md CR-01, CR-02, CR-05, CR-06, CR-09; app chat-runtime.md AP-2690…): the
 * composer's round icon before the paperclip (chat-runtime-icon.md AP-2960): the provider's mark, a bolt on it with fast
 * replies on, “Opus · Automatic” on hover — and its popover above it:
 * “Neo answers with” Claude · ChatGPT (· Local where the Whombat has a model on its network: its models, “Another model”,
 * no Effort or Fast replies; hermes-engine-app.md AP-5044), the usage line, the models (four, or three and “N more…”),
 * Effort, Fast replies, and the footer's scope with “Make this Neo’s default”. In a thread the switch shows the thread's
 * provider alone: it keeps the one it started with (thread-provider.md AP-5600). Escape closes it and focus goes back to
 * the button.
 */
export function ChatRuntimeButton({
  view,
  runtime,
  inThread,
  threadState = null,
  onChange,
  onMakeDefault,
  setUpHref = { to: '/settings', search: { tab: 'ai' } },
}: ChatRuntimeButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const describedId = useId();
  const button = chatRuntimeButton(view, runtime);
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx(styles.button, open && styles.open)}
        aria-label={button.ariaLabel}
        aria-describedby={describedId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-chat-runtime=""
      >
        <ProviderMark provider={button.provider} size={16} />
        {button.fast && (
          <span className={styles.buttonBolt} data-fast="">
            <Bolt size={10} />
          </span>
        )}
        <span className={styles.buttonTip} aria-hidden="true">
          {chatRuntimeLine(button)}
        </span>
        <span id={describedId} className={styles.srOnly}>
          {`${button.providerLabel} · ${button.label}${button.fast ? ` · ${CHAT_RUNTIME_COPY.fast}` : ''}`}
        </span>
      </button>
      {open && (
        <ChatRuntimePopover
          anchor={buttonRef.current}
          view={view}
          runtime={runtime}
          inThread={inThread}
          threadState={threadState}
          onChange={onChange}
          onMakeDefault={
            onMakeDefault
              ? (r) => {
                  onMakeDefault(r);
                  close(true);
                }
              : undefined
          }
          setUpHref={setUpHref}
          onClose={close}
        />
      )}
    </>
  );
}

interface PopoverProps extends Omit<ChatRuntimeButtonProps, 'setUpHref'> {
  anchor: HTMLElement | null;
  setUpHref: { to: string; search?: Record<string, unknown> };
  onClose: (restoreFocus: boolean) => void;
}

function ChatRuntimePopover({
  anchor,
  view,
  runtime,
  inThread,
  threadState,
  onChange,
  onMakeDefault,
  setUpHref,
  onClose,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const [allModels, setAllModels] = useState(false);
  const ids = { answers: useId(), fast: useId(), effort: useId(), name: useId() };
  const base = view.default;
  const models = chatModelsOf(view, runtime.provider);
  const provider = chatProviderOf(view, runtime.provider);
  // A started thread keeps its provider (Whombat HN-06; AP-5600): its own segment only, its own words.
  const segments = chatProviderSegments(view, runtime, inThread);
  const hints = chatProviderHints(view, inThread ? runtime.provider : undefined);
  const list = chatModelRows(models, runtime.model, allModels);
  const efforts = chatEffortChoices(models, runtime);
  const fast = chatFastRow(provider, runtime, inThread ? threadState : null);
  const makeDefault = onMakeDefault && chatMakeDefaultShown(view, runtime);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    // Its right edge on the icon's, which sits near the box's right end (AP-2960).
    setPlace({
      left: Math.max(GAP, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - GAP)),
      bottom: window.innerHeight - r.top + GAP,
      maxHeight: r.top - GAP * 2,
    });
    ref.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus stays in the popover while it is open; Escape leaves it.
    const focusable = [
      ...(ref.current?.querySelectorAll<HTMLElement>(
        'input:checked, input:not([type="radio"]), button, a[href]',
      ) ?? []),
    ].filter((el) => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const fastOn = fast.kind === 'offered' && fast.on;
  let fastRow: ReactNode = null;
  if (fast.kind !== 'hidden') {
    const off = fast.kind !== 'offered';
    fastRow = (
      <div className={cx(styles.fastRow, off && styles.fastOff)} data-fast-row={fast.kind}>
        <span className={styles.fastBolt}>
          <Bolt size={16} />
        </span>
        <div className={styles.fastText}>
          <div className={styles.fastTitle}>{fast.title}</div>
          <div id={ids.fast} className={styles.fastHint}>
            {fast.text}
          </div>
          {fast.kind === 'offered' && fast.note && <div className={styles.fastNote}>{fast.note}</div>}
        </div>
        <Toggle
          className={cx(styles.switch, fastOn && styles.switchOn)}
          checked={fastOn}
          disabled={off}
          aria-label={fast.title}
          aria-describedby={ids.fast}
          onCheckedChange={(on) => onChange(chatDraftWithFast(runtime, on, models, base))}
          data-fast-switch=""
        />
      </div>
    );
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={CHAT_RUNTIME_COPY.buttonLabel(view.assistantName)}
      className={styles.popover}
      style={
        place
          ? { left: place.left, bottom: place.bottom, maxHeight: place.maxHeight }
          : { left: -9999, bottom: 0 }
      }
      onKeyDown={onKeyDown}
      data-chat-runtime-popover=""
    >
      <div className={styles.section}>
        <div id={ids.answers} className={styles.label}>
          {CHAT_RUNTIME_COPY.answersWith(view.assistantName)}
        </div>
        <fieldset className={styles.segments} aria-labelledby={ids.answers}>
          {segments.map((s) => (
            <label
              key={s.provider}
              className={cx(styles.segment, s.picked && styles.segmentOn, !s.ready && styles.segmentOff)}
              data-provider={s.provider}
            >
              <input
                type="radio"
                className={styles.srOnly}
                name={`${ids.name}-provider`}
                checked={s.picked}
                disabled={!s.ready && !s.picked}
                onChange={() => {
                  onChange(chatDraftWithProvider(runtime, s.provider, base));
                  setAllModels(false);
                }}
              />
              <ProviderMark provider={s.provider} size={15} />
              {s.label}
            </label>
          ))}
        </fieldset>
        {hints.usage && <div className={styles.hint}>{hints.usage}</div>}
        {hints.notSetUp.map((h) => (
          <div key={h.provider} className={styles.hint} data-not-set-up={h.provider}>
            {h.text}{' '}
            <Link
              to={setUpHref.to}
              search={setUpHref.search as never}
              className={styles.setUp}
              onClick={() => onClose(false)}
            >
              {CHAT_RUNTIME_COPY.setUp}
            </Link>
          </div>
        ))}
      </div>
      <fieldset className={styles.models} aria-label={CHAT_RUNTIME_COPY.model}>
        {list.rows.map((m) => (
          <label
            key={m.id ?? ''}
            className={cx(styles.model, m.picked && styles.modelOn)}
            data-model={m.id ?? ''}
          >
            <input
              type="radio"
              className={styles.srOnly}
              name={`${ids.name}-model`}
              checked={m.picked}
              onChange={() => onChange(chatDraftWithModel(runtime, m.id, models, base))}
            />
            <span className={styles.check} aria-hidden="true">
              {m.picked ? '✓' : ''}
            </span>
            <span className={styles.modelName}>{m.label}</span>
            <span className={styles.modelDescription}>{m.description}</span>
            {m.isDefault && <span className={styles.tag}>{CHAT_RUNTIME_COPY.defaultTag}</span>}
          </label>
        ))}
        {list.more > 0 && (
          <button
            type="button"
            className={styles.more}
            onClick={() => {
              setAllModels(true);
            }}
            data-more-models=""
          >
            {CHAT_RUNTIME_COPY.more(list.more)}
          </button>
        )}
      </fieldset>
      {runtime.provider === 'local' && (
        <div className={cx(styles.section, styles.effortSection)}>
          <AnotherModel
            compact
            onUse={(model) => onChange(chatDraftWithModel(runtime, model, models, base))}
          />
        </div>
      )}
      {efforts.length > 0 && (
        <div className={cx(styles.section, styles.effortSection)}>
          <div id={ids.effort} className={styles.label}>
            {CHAT_RUNTIME_COPY.effort}
          </div>
          <fieldset className={styles.efforts} aria-labelledby={ids.effort}>
            {efforts.map((e) => (
              <label key={e.value ?? 'automatic'} className={cx(styles.effort, e.picked && styles.effortOn)}>
                <input
                  type="radio"
                  className={styles.srOnly}
                  name={`${ids.name}-effort`}
                  checked={e.picked}
                  onChange={() => onChange(chatDraftWithEffort(runtime, e.value, models, base))}
                />
                {e.label}
              </label>
            ))}
          </fieldset>
          <div className={styles.hint}>{CHAT_RUNTIME_COPY.effortHint}</div>
        </div>
      )}
      {fastRow}
      <div className={styles.footer}>
        <span className={styles.scope}>{chatRuntimeScope(inThread)}</span>
        {makeDefault && (
          <button
            type="button"
            className={styles.makeDefault}
            onClick={() => onMakeDefault?.(runtime)}
            data-make-default=""
          >
            {CHAT_RUNTIME_COPY.makeDefault(view.assistantName)}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
