// Typings for the parts of spice-html5 that Rackoon uses (vendored JS, LGPL-3.0).

export interface SpiceMainConnOptions {
  uri: string;
  password: string;
  screen_id?: string;
  message_id?: string;
  dump_id?: string;
  onerror?: (e: Error | Event) => void;
  onsuccess?: (message: string) => void;
  onagent?: (sc: SpiceMainConn) => void;
}

export class SpiceMainConn {
  constructor(o: SpiceMainConnOptions);
  state: string;
  /** Rackoon patch: clipboard sharing with the guest agent (off unless true). */
  clipboard_sharing?: boolean;
  stop(): void;
}

export function sendCtrlAltDel(sc: SpiceMainConn): void;
/** Rackoon patch: press PC set-1 scancodes in order, release them in reverse. */
export function sendScancodes(sc: SpiceMainConn, codes: number[]): void;
export function typeText(sc: SpiceMainConn, text: string, delayMs?: number): Promise<{ typed: number; skipped: string[]; aborted: boolean }>;
export function resize_helper(sc: SpiceMainConn): void;
export function handle_resize(e: Event): void;
