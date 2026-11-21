/**
 * ChatGPT's sign-in (SUB-03, AP-62): OpenAI's device code, which the Whombat asks for through Hermes's own device-code
 * login (Whombat hermes-native.md HN-03, HN-C03; chatgpt-no-client.md AP-5612), in the guided steps of the Claude
 * sign-in. Step 1 opens the page the server named (only an `https:` page on openai.com or chatgpt.com gets a button),
 * step 2 shows the one-time code to enter there, then the attempt says how it went. The code stays in this
 * component's state only (a `secret` op's answer, CT-44) and the attempt is polled every 3 s until it's done, expired
 * or cancelled. GitHub's device code on a managed Whombat (essentials item 6, AP-494) is the same flow with GitHub's
 * words and only github.com pages as a button (`kind="github"`).
 */
import { useWhombat } from '@whombat/client/react';
import {
  codexSignInUrl,
  GITHUB_SIGNIN_TEXT,
  githubSignInUrl,
  linkHost,
  SIGNIN_TEXT,
  timeLeft,
} from '@whombat/client/signins';
import type { ProviderLogin } from '@whombat/core/domain';
import { useEffect, useRef, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { StatusDot } from '../../components/StatusDot';
import styles from './ai.module.css';
import { focusIfFree, Step, Steps } from './Steps';
import { must } from './useAi';

/** Each device sign-in's words and the pages that get a button. */
const KINDS = {
  codex: { text: SIGNIN_TEXT.device, url: codexSignInUrl },
  github: { text: GITHUB_SIGNIN_TEXT.device, url: githubSignInUrl },
} as const;

/** How often the attempt is asked about (tests shorten it). */
export const DEVICE_POLL = { ms: 3_000 };

export interface DeviceCodeProps {
  login: ProviderLogin;
  onSignedIn: () => void;
  /** Start a new attempt (after it expired or failed). */
  onRestart: () => void;
  onClose: () => void;
  /** Whose device code: ChatGPT's (`codex`, the default) or GitHub's. */
  kind?: keyof typeof KINDS;
}

export function DeviceCode({
  login: first,
  onSignedIn,
  onRestart,
  onClose,
  kind = 'codex',
}: DeviceCodeProps) {
  const { client } = useWhombat();
  const T = KINDS[kind].text;
  const [login, setLogin] = useState(first);
  const [now, setNow] = useState(() => Date.now());
  const [opened, setOpened] = useState(false);
  const root = useRef<HTMLElement>(null);
  const openLink = useRef<HTMLAnchorElement>(null);
  const restart = useRef<HTMLButtonElement>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  useEffect(() => {
    setLogin(first);
    setOpened(false);
  }, [first]);

  // Ask how it's going until it's over.
  useEffect(() => {
    if (login.state !== 'awaiting_user') return;
    const t = setTimeout(() => {
      client.signins.loginStatus({ params: { loginId: login.loginId } }).then(
        (l) => {
          setLogin(l);
          if (l.state === 'completed') signedIn.current();
        },
        () => setLogin((l) => ({ ...l })), // try again next round
      );
    }, DEVICE_POLL.ms);
    return () => clearTimeout(t);
  }, [client, login]);

  // The countdown.
  useEffect(() => {
    if (login.state !== 'awaiting_user') return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [login.state]);

  const cancel = async () => {
    if (login.state === 'awaiting_user')
      await client.signins
        .loginCancel({ params: { loginId: login.loginId } })
        .then(must)
        .catch(() => {});
    onClose();
  };

  const device = login.device;
  const url = device ? KINDS[kind].url(device.verificationUri) : null;
  const expired =
    login.state === 'expired' ||
    (login.state === 'awaiting_user' && device && Date.parse(device.expiresAt) <= now);
  const failed = login.state === 'failed' || login.state === 'cancelled';
  const done = login.state === 'completed';
  const over = !!expired || failed;
  const steps = !!device && !over && !done;

  // Focus follows the steps: the page's button first, then (opened) the code's copy button; “Get a new code” when over.
  const hasDevice = !!device;
  useEffect(() => {
    if (hasDevice) focusIfFree(openLink.current, root.current);
  }, [hasDevice]);
  useEffect(() => {
    if (over) focusIfFree(restart.current, root.current);
  }, [over]);

  const status = expired
    ? T.expired
    : failed
      ? (login.error?.message ?? SIGNIN_TEXT.failed)
      : done
        ? T.completed
        : T.waiting;

  return (
    <section ref={root} className={styles.guided} aria-label={T.label}>
      {device && steps ? (
        <Steps>
          <Step n={1} state={opened ? 'done' : 'active'} align="center">
            {url ? (
              <div className={styles.stepRow}>
                <ButtonLink
                  ref={openLink}
                  variant={opened ? 'secondary' : 'primary'}
                  size="sm"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpened(true)}
                  iconEnd={<Icon name="external" size={15} />}
                >
                  {T.open(linkHost(url))}
                </ButtonLink>
                <span className={styles.stepHint}>{T.openHint}</span>
              </div>
            ) : null}
            <span className={styles.stepHint}>
              {url ? `${T.elsewhere} ` : null}
              <span className={styles.stepMono}>{device.verificationUri}</span>
            </span>
          </Step>
          <Step n={2} state={opened || !url ? 'active' : 'todo'}>
            <span className={styles.stepTitle}>{T.enter}</span>
            <div className={styles.deviceCodeRow}>
              <code className={styles.deviceCode}>{device.userCode}</code>
              <CopyButton text={device.userCode} copied={T.copied} className={styles.linkButton}>
                {T.copy}
              </CopyButton>
              <span className={styles.deviceExpiry}>{T.expiresIn(timeLeft(device.expiresAt, now))}</span>
            </div>
            <span className={styles.stepHint}>{T.hint}</span>
          </Step>
        </Steps>
      ) : null}

      {steps ? <p className={styles.trust}>{T.trust}</p> : null}

      <div className={styles.flowFooter}>
        <span className={styles.flowStatus} role="status">
          <StatusDot tone={over ? 'bad' : done ? 'ok' : 'warn'} size={8} label={null} />
          <span>{status}</span>
        </span>
        <span className={styles.flowActions}>
          {over ? (
            <>
              <Button ref={restart} variant="primary" size="sm" onClick={onRestart}>
                {T.newCode}
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {T.close}
              </Button>
            </>
          ) : done ? (
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
    </section>
  );
}
