/**
 * The relay door's streams on the box (docs/decisions/own-address.md): what the relay client hands over after `ready`.
 *
 * - `web`: a browser's TLS connection, to the own-address listener (`DirectListener.acceptDoor`), which ends TLS here.
 * - `acme`: a certificate authority's TLS-ALPN-01 validation, piped byte for byte into the manager's ACME socket; the
 *   runtime never parses it, and the key and challenge certificate never leave the manager.
 *
 * Each class has its own budget at once (`DOOR_BUDGETS`), apart from the app's sessions; past it the relay is told
 * `refuse` and closes the visitor's connection.
 */
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { OWN_ADDRESS_ACME_CONNECTIONS_MAX } from '@whombat/control-contracts/local';
import type { RelayDoorClass } from '@whombat/protocol/relay';
import type { Logger } from '../../services';
import type { RelayDoorPort } from '../session/relay-client';

/** Door streams open at once, per class. */
export const DOOR_BUDGETS: Readonly<Record<RelayDoorClass, number>> = {
  web: 64,
  acme: OWN_ADDRESS_ACME_CONNECTIONS_MAX,
};

export interface OwnAddressDoorOptions {
  /** What this box takes now (the own-address state decides). */
  accepts(): readonly RelayDoorClass[];
  /** A `web` stream for the own-address listener. */
  web(stream: Duplex, src: string): void;
  /** Whether browsers may open the address now (`webOpen`, a phase 2 seam: closed while a foreign certificate is valid). */
  webOpen(): boolean;
  /** The manager's ACME socket. */
  acmeSocket: string;
  log: Logger;
  budgets?: Readonly<Record<RelayDoorClass, number>>;
}

export class OwnAddressDoor implements RelayDoorPort {
  private readonly open: Record<RelayDoorClass, number> = { web: 0, acme: 0 };
  readonly stats = { web: 0, acme: 0, refused: 0, acmeFailures: 0 };

  constructor(private readonly options: OwnAddressDoorOptions) {}

  accepts(): readonly RelayDoorClass[] {
    return this.options.accepts();
  }

  /** Open streams per class (diagnostics). */
  get counts(): Readonly<Record<RelayDoorClass, number>> {
    return { ...this.open };
  }

  admit(cls: RelayDoorClass): (() => void) | null {
    const budget = (this.options.budgets ?? DOOR_BUDGETS)[cls];
    if (this.open[cls] >= budget || (cls === 'web' && !this.options.webOpen())) {
      this.stats.refused += 1;
      return null;
    }
    this.open[cls] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.open[cls] -= 1;
    };
  }

  onStream(stream: Duplex, cls: RelayDoorClass, src: string): void {
    this.stats[cls] += 1;
    if (cls === 'web') {
      this.options.web(stream, src);
      return;
    }
    const manager = connect(this.options.acmeSocket);
    const fail = () => {
      this.stats.acmeFailures += 1;
      manager.destroy();
      stream.destroy();
    };
    manager.once('error', (err) => {
      this.options.log.info({ err: String(err) }, 'own address: the manager’s ACME socket didn’t answer');
      fail();
    });
    stream.once('error', () => manager.destroy());
    stream.once('close', () => manager.destroy());
    // The manager's end ends the stream once what it wrote is out (a close of the data connection, not a reset).
    stream.pipe(manager).pipe(stream);
  }
}
