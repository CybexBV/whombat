/**
 * The Claude subscription sign-in (CT-71, SUB-03, AP-62): Claude Code's own `claude auth login --claudeai`, with guided
 * steps in front of it. Step 1 opens the link Claude Code printed (read from its output: the OSC 8 hyperlink, else the
 * text after “visit:”; only Claude's own hosts get a button). Step 2 takes the code from claude.ai in one field and
 * types it, followed by Enter, into Claude Code's prompt — the same keystrokes the terminal would send. Then Claude
 * Code says whether it worked. The terminal itself stays one click away (“Show Claude Code’s output”) and works as
 * before.
 *
 * Output, keystrokes and the code live only in the terminal and this component's state: never logged, cached or
 * stored; the field is cleared once the code is sent. Closing the panel cancels a console that still runs.
 */
import { useWhombat } from '@whombat/client/react';
import {
  type ConsoleDriver,
  type ConsoleDriverState,
  consoleApiOf,
  createConsoleDriver,
  createSignInOutputWatcher,
  isCodeShaped,
  SIGNIN_TEXT,
  type SignInOutput,
} from '@whombat/client/signins';
import type { ProviderConsole } from '@whombat/core/domain';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import styles from './ai.module.css';
import { focusIfFree, Step, Steps } from './Steps';
import type { MountTerminal } from './terminal';

const T = SIGNIN_TEXT.console;

/**
 * xterm measures a character once, when it opens: wait for the mono web font first, or it measures the fallback and
 * spaces DM Mono's letters out.
 */
const loadTerminal = async (): Promise<MountTerminal> => {
  const [mod] = await Promise.all([
    import('./terminal'),
    document.fonts
      ?.load(`13px ${getComputedStyle(document.documentElement).getPropertyValue('--font-mono')}`)
      .catch(() => []),
  ]);
  return mod.mountTerminal;
};

export interface ClaudeSignInProps {
  /** A running console of this person (from `signins.list`) to pick up instead of starting one. */
  resume?: ProviderConsole | null;
  /** The console says signed in (the sign-in is in `signins.list` now). */
  onSignedIn?: () => void;
  /** Close the panel (after Cancel or once done). */
  onClose: () => void;
  /** Tests: a terminal without xterm. */
  terminal?: () => Promise<MountTerminal>;
}

const NO_OUTPUT: SignInOutput = { url: null, foreignUrl: false, loginFailed: false, prompts: 0 };

const sameOutput = (a: SignInOutput, b: SignInOutput) =>
  a.url === b.url &&
  a.foreignUrl === b.foreignUrl &&
  a.loginFailed === b.loginFailed &&
  a.prompts === b.prompts;

/**
 * Characters typed into the terminal since the last Enter, after `data`: printable characters count, Backspace takes
 * one back, escape sequences (arrow keys, paste markers) and controls don't count.
 */
export function typedAfter(count: number, data: string): number {
  let n = count;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x1b) {
      // ESC [ … final byte (0x40–0x7e), or ESC and one more character.
      if (data[i + 1] === '[') {
        i += 2;
        while (i < data.length && !(data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e)) i++;
      } else i++;
      continue;
    }
    if (c === 0x7f || c === 0x08) n = Math.max(0, n - 1);
    else if (c >= 0x20) n++;
  }
  return n;
}

/**
 * The clipboard's text when the browser already lets this page read it (never asks) and it looks like a code; else
 * null. Only ever offered in the field, never sent by itself.
 */
async function codeFromClipboard(): Promise<string | null> {
  try {
    const status = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    if (status?.state !== 'granted') return null;
    const text = await navigator.clipboard.readText();
    return isCodeShaped(text) ? text.trim() : null;
  } catch {
    return null;
  }
}

export function ClaudeSignIn({ resume, onSignedIn, onClose, terminal = loadTerminal }: ClaudeSignInProps) {
  const { client } = useWhombat();
  const ids = { code: useId(), output: useId(), problem: useId() };
  const root = useRef<HTMLElement>(null);
  const host = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const openLink = useRef<HTMLAnchorElement>(null);
  const restart = useRef<HTMLButtonElement>(null);
  const driver = useRef<ConsoleDriver | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  const resumeRef = useRef(resume);

  const [state, setState] = useState<ConsoleDriverState>({ phase: 'starting', console: null, error: null });
  /** Each “Get a new link” starts a new console. */
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  /** What Claude Code's output said so far: its link, “Login failed”, how often it asked for the code. */
  const [output, setOutput] = useState<SignInOutput>(NO_OUTPUT);
  const outputRef = useRef(output);
  outputRef.current = output;
  /** Step 1 is done: the person opened the link. */
  const [opened, setOpened] = useState(false);
  /** The code in the field (component state only; cleared once sent). */
  const [code, setCode] = useState('');
  const codeRef = useRef(code);
  codeRef.current = code;
  /** A code went to Claude Code (from the field, or typed into the terminal and Enter): now it checks. */
  const [sent, setSent] = useState(false);
  const promptsAtSend = useRef(0);
  /** Claude Code doesn't echo the code at its prompt: how much was typed into the terminal since the last Enter. */
  const [typed, setTyped] = useState(0);
  const typedRef = useRef(0);
  const [showOutput, setShowOutput] = useState(false);
  const [pasteProblem, setPasteProblem] = useState(false);

  const markSent = useCallback(() => {
    promptsAtSend.current = outputRef.current.prompts;
    setSent(true);
  }, []);

  useEffect(() => {
    let disposed = false;
    let view: ReturnType<MountTerminal> | null = null;
    let d: ConsoleDriver | null = null;
    const watcher = createSignInOutputWatcher();
    setState({ phase: 'starting', console: null, error: null });
    setOutput(NO_OUTPUT);
    setOpened(false);
    setCode('');
    setSent(false);
    setTyped(0);
    typedRef.current = 0;
    setPasteProblem(false);
    terminal().then(
      (mount) => {
        const el = host.current;
        if (disposed || !el) return;
        view = mount(el);
        const v = view;
        d = createConsoleDriver({
          api: consoleApiOf(client),
          resume: attempt === 0 ? resumeRef.current : null,
          cols: v.cols,
          rows: v.rows,
          onOutput: (bytes) => {
            v.write(bytes);
            const next = watcher.push(bytes);
            if (!disposed) setOutput((prev) => (sameOutput(prev, next) ? prev : next));
          },
          onState: (s) => {
            if (disposed) return;
            setState(s);
            if (s.phase === 'completed') signedIn.current?.();
          },
        });
        driver.current = d;
        // Typing in Claude Code's own terminal still works: Enter after a code counts as sending it.
        v.onData((data) => {
          d?.input(data);
          const enter = data.lastIndexOf('\r');
          if (enter >= 0) {
            const before = typedAfter(typedRef.current, data.slice(0, enter));
            typedRef.current = typedAfter(0, data.slice(enter + 1));
            if (before > 0) markSent();
          } else typedRef.current = typedAfter(typedRef.current, data);
          setTyped(typedRef.current);
        });
        v.onResize(({ cols, rows }) => d?.resize(cols, rows));
      },
      () => {
        if (!disposed) setLoadFailed(true);
      },
    );
    return () => {
      disposed = true;
      driver.current = null;
      void d?.close();
      view?.dispose();
    };
  }, [client, attempt, terminal, markSent]);

  // Claude Code asked for the code again (it didn't take the last one without exiting): back to step 2.
  useEffect(() => {
    if (sent && output.prompts > promptsAtSend.current) setSent(false);
  }, [sent, output.prompts]);

  const { phase } = state;
  const running = phase === 'running' && !loadFailed && !output.loginFailed;
  const live = (phase === 'starting' || running) && !loadFailed && !output.loginFailed;
  const waitingForCode = running && !sent;
  const linkShown = output.url != null || output.foreignUrl;

  // The link appeared: step 1's button is where to go next. A link to another host gets no button: the output opens.
  useEffect(() => {
    if (output.url) focusIfFree(openLink.current, root.current);
  }, [output.url]);
  useEffect(() => {
    if (output.foreignUrl) setShowOutput(true);
  }, [output.foreignUrl]);

  // Back from claude.ai (the tab or the window again): the field, with the code already in it when the browser lets
  // this page read the clipboard without asking and it holds a code. Never sent by itself.
  useEffect(() => {
    if (!waitingForCode || !linkShown) return;
    let current = true;
    const back = () => {
      if (document.visibilityState === 'hidden') return;
      field.current?.focus();
      if (codeRef.current) return;
      void codeFromClipboard().then((found) => {
        if (current && found && !codeRef.current) setCode(found);
      });
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      current = false;
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [waitingForCode, linkShown]);

  const open = () => {
    setOpened(true);
    // Step 2 is next: its field (the new tab has the focus now; this is where the person comes back to).
    field.current?.focus();
  };

  const paste = async () => {
    setPasteProblem(false);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) setCode(text);
    } catch {
      setPasteProblem(true);
    }
    field.current?.focus();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value || !waitingForCode) return;
    // The code, then Enter: Claude Code's prompt shows nothing and acts only on Enter.
    driver.current?.input(`${value}\r`);
    setCode('');
    setPasteProblem(false);
    markSent();
  };

  const cancel = async () => {
    await driver.current?.close();
    onClose();
  };

  const again = () => {
    setLoadFailed(false);
    setAttempt((n) => n + 1);
  };

  // What went wrong, and what starts again.
  const failure: { text: string; action: string } | null = loadFailed
    ? { text: T.loadFailed, action: T.tryAgain }
    : output.loginFailed || (phase === 'failed' && sent)
      ? { text: T.codeFailed, action: T.newLink }
      : phase === 'failed'
        ? { text: state.error?.message ?? T.failed, action: linkShown ? T.newLink : T.tryAgain }
        : phase === 'expired'
          ? { text: T.expired, action: T.newLink }
          : phase === 'cancelled'
            ? {
                text:
                  state.error?.message && state.error.code !== 'provider.login_cancelled'
                    ? `${T.cancelled} ${state.error.message}`
                    : T.cancelled,
                action: T.newLink,
              }
            : null;

  // Something went wrong: “Get a new link” is where to go next.
  const failed = failure != null;
  useEffect(() => {
    if (failed) focusIfFree(restart.current, root.current);
  }, [failed]);

  const tone: DotTone = failure ? 'bad' : phase === 'completed' ? 'ok' : 'warn';
  const status = failure
    ? failure.text
    : phase === 'completed'
      ? T.completed
      : !running || !linkShown
        ? T.starting
        : sent
          ? T.checking
          : typed > 0
            ? T.entered(typed)
            : T.waiting;

  return (
    <section ref={root} className={styles.guided} aria-label={T.label}>
      {live ? (
        <Steps>
          <Step n={1} state={opened || sent ? 'done' : 'active'} align="center">
            {output.url ? (
              <div className={styles.stepRow}>
                <ButtonLink
                  ref={openLink}
                  variant={opened || sent ? 'secondary' : 'primary'}
                  size="sm"
                  href={output.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={open}
                  iconEnd={<Icon name="external" size={15} />}
                >
                  {T.open}
                </ButtonLink>
                <span className={styles.stepHint}>{T.openHint}</span>
              </div>
            ) : (
              <span className={styles.stepText}>{output.foreignUrl ? T.noLink : T.starting}</span>
            )}
          </Step>
          <Step n={2} state={sent ? 'done' : opened ? 'active' : 'todo'}>
            <form className={styles.codeForm} onSubmit={submit}>
              <label className={styles.stepTitle} htmlFor={ids.code}>
                {T.code}
              </label>
              <div className={styles.codeRow}>
                <Input
                  ref={field}
                  id={ids.code}
                  className={styles.codeInput}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-form-type="other"
                  aria-describedby={pasteProblem ? ids.problem : undefined}
                  value={code}
                  disabled={!waitingForCode}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button variant="secondary" size="sm" disabled={!waitingForCode} onClick={() => void paste()}>
                  {T.paste}
                </Button>
                <Button variant="primary" size="sm" type="submit" disabled={!waitingForCode || !code.trim()}>
                  {T.signIn}
                </Button>
              </div>
              {pasteProblem ? (
                <span id={ids.problem} className={styles.stepHint}>
                  {T.pasteDenied}
                </span>
              ) : null}
            </form>
          </Step>
        </Steps>
      ) : null}

      {live ? <p className={styles.trust}>{T.trust}</p> : null}

      <div className={styles.flowFooter}>
        <span className={styles.flowStatus} role="status">
          <StatusDot tone={tone} size={8} label={null} />
          <span>{status}</span>
        </span>
        <span className={styles.flowActions}>
          {failure ? (
            <>
              <Button ref={restart} variant="primary" size="sm" onClick={again}>
                {failure.action}
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {T.close}
              </Button>
            </>
          ) : phase === 'completed' ? (
            <Button variant="secondary" size="sm" onClick={onClose}>
              {T.close}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => void cancel()}>
              {T.cancel}
            </Button>
          )}
        </span>
      </div>

      <div className={styles.outputBox}>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={showOutput}
          aria-controls={ids.output}
          onClick={() => setShowOutput((v) => !v)}
        >
          <Icon icon={ChevronRight} size={15} className={styles.disclosureIcon} />
          {T.output}
        </button>
        {/* Laid out while closed (hidden, not display:none): xterm measures its cells and the fit follows the box. */}
        <div
          id={ids.output}
          className={styles.output}
          data-open={showOutput || undefined}
          inert={!showOutput}
        >
          <section ref={host} className={styles.terminal} aria-label={T.outputLabel} data-phase={phase} />
        </div>
      </div>
    </section>
  );
}
