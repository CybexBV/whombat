/**
 * Where a provider sign-in is, as one step to show (Whombat first-day.md): the phone's Connect your AI runs the same
 * two flows as the web's Settings → AI — ChatGPT's device code, Claude Code's own sign-in (a link, then the code
 * claude.ai shows, pasted back) — and opens the provider's page in its in-app browser. Neither flow needs a redirect back
 * into the app: the code travels through the person's clipboard. Pure, so the phone's view is tested.
 */
import type { ProviderLogin } from '@whombat/core/domain';
import type { ConsoleDriverState } from './console';
import { SIGNIN_TEXT, timeLeft } from './copy';
import { codexSignInUrl, linkHost, type SignInOutput } from './guided';

/** ChatGPT's device code, now. */
export type DeviceStep =
  /** Open `url`, enter `code` before it runs out. */
  | { kind: 'code'; code: string; url: string; host: string; expiresIn: string }
  | { kind: 'done' }
  /** Over without a sign-in: say `text`, offer a new code. */
  | { kind: 'over'; text: string };

export function deviceStep(login: ProviderLogin, now: number): DeviceStep {
  const T = SIGNIN_TEXT.device;
  if (login.state === 'completed') return { kind: 'done' };
  const device = login.device;
  const url = device ? codexSignInUrl(device.verificationUri) : null;
  if (login.state === 'awaiting_user' && device && url && Date.parse(device.expiresAt) > now)
    return {
      kind: 'code',
      code: device.userCode,
      url,
      host: linkHost(url),
      expiresIn: timeLeft(device.expiresAt, now),
    };
  if (login.state === 'awaiting_user' || login.state === 'expired') return { kind: 'over', text: T.expired };
  return { kind: 'over', text: login.error?.message ?? SIGNIN_TEXT.failed };
}

/** Claude Code's sign-in, now. */
export type ConsoleStep =
  | { kind: 'starting' }
  /** Open `url` (claude.ai), approve, copy the code it shows. */
  | { kind: 'open'; url: string; host: string }
  /** The code was sent: Claude Code checks it. */
  | { kind: 'checking' }
  | { kind: 'done' }
  /** Over without a sign-in: say `text`; `action` starts again. */
  | { kind: 'over'; text: string; action: string };

export function consoleStep(input: {
  state: ConsoleDriverState;
  output: SignInOutput;
  /** A code was sent since the last prompt for one. */
  sent: boolean;
}): ConsoleStep {
  const T = SIGNIN_TEXT.console;
  const { state, output, sent } = input;
  const { phase } = state;
  if (phase === 'completed') return { kind: 'done' };
  if (output.loginFailed || (phase === 'failed' && sent))
    return { kind: 'over', text: T.codeFailed, action: T.newLink };
  if (phase === 'failed') return { kind: 'over', text: state.error?.message ?? T.failed, action: T.tryAgain };
  if (phase === 'expired') return { kind: 'over', text: T.expired, action: T.newLink };
  if (phase === 'cancelled') return { kind: 'over', text: T.cancelled, action: T.newLink };
  // A link to another host than claude.ai's isn't offered as a button (the web shows the output instead).
  if (phase === 'starting' || !output.url) return { kind: 'starting' };
  if (sent) return { kind: 'checking' };
  return { kind: 'open', url: output.url, host: linkHost(output.url) };
}
