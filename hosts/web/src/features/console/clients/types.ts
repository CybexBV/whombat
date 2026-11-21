// What the console panel needs from each client (terminal, noVNC, SPICE).

import type { ComboKey } from '../keyCombos';
import type { ConsoleTransport } from '../transport';

export interface ScreenHandle {
  /** Move keyboard focus into the client (capture keys). */
  capture(): void;
  /** Release keyboard capture (focus goes back to the screen frame). */
  release(): void;
  /** Send text: a terminal pastes it, VNC/SPICE type it as key events. Resolves when sent. */
  paste(text: string, opts: { raw: boolean }): Promise<void>;
  /** Ctrl+Alt+Del to the guest (graphical clients only). */
  ctrlAltDel?(): void;
  /** Press the keys in order, release them in reverse (graphical clients only). */
  sendCombo?(keys: ComboKey[]): void;
  /** Raw bytes to a terminal (its key row: Esc, Tab, Ctrl+C, arrows). */
  sendRaw?(data: string): void;
  /** Selection, or the whole buffer when nothing is selected (terminals only). */
  copyText?(): { text: string; lines: number; selection: boolean };
}

export interface ScreenProps {
  transport: ConsoleTransport;
  /** Accessible name of the client's focus target. */
  label: string;
  /** "132×36" for terminals, framebuffer size for graphical consoles. */
  onSize: (size: string) => void;
  /** Called when the client gives keyboard focus back (Ctrl+Alt). */
  onRelease: () => void;
  /** A client-side failure (e.g. the VNC server asked for a password). */
  onError: (message: string) => void;
  /** The client is up and takes input (terminal opened, RFB handshake done, SPICE display shown). */
  onReady: () => void;
  /** A read-only stream (logs): the terminal takes no input. */
  readOnly?: boolean;
  /** Terminal font size in px instead of one scaled to the screen width. */
  fontSize?: number;
}
