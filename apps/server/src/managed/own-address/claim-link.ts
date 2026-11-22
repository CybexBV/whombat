/**
 * The claim link of a box inside A3 (docs/decisions/own-address.md): `https://<host>/c/<six letters>`, shown on the box's
 * screen once its own address works. A claim on the own address needs it, so someone who found the label in
 * Certificate Transparency can't start a claim, nor spend the claim's backoff.
 *
 * Nothing a visitor does changes it: the link on the screen, or open in the person's browser, stays good whatever
 * strangers try. It changes after a claim and when someone at the box asks for new letters, which draws the screen
 * again with it. Wrong tries are held back on their own, per visitor address: an address has
 * `CLAIM_LINK_TRIES_PER_PEER` different wrong links in an hour, and after those the box reads no other link from it
 * until one falls out of the hour. So a stranger's tries never cost the person theirs. Memory only: a restart shows a
 * new link.
 */
import { randomInt } from 'node:crypto';
import { safeEqual } from '../../lib/secrets';

/** The claim alphabet in lower case (`OwnAddressClaimSecret`). */
const LETTERS = 'abcdefghjkmnpqrtvwxy';
/** Different wrong links one visitor address may show in an hour. */
export const CLAIM_LINK_TRIES_PER_PEER = 10;
/** Visitor addresses whose wrong tries are remembered at once; past it the oldest is forgotten. */
export const CLAIM_LINK_PEERS = 1024;
const HOUR_MS = 3_600_000;

export function newClaimLinkSecret(random: (n: number) => number = randomInt): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += LETTERS[random(LETTERS.length)];
  return out;
}

export class ClaimLink {
  private secret: string;
  /** The wrong links each visitor address showed in the last hour, with when it first did. */
  private readonly wrong = new Map<string, Map<string, number>>();
  /** The link changed: the manager is told, so control never keeps one that stopped working. */
  onRotate: (() => void) | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => number = randomInt,
  ) {
    this.secret = newClaimLinkSecret(random);
  }

  get current(): string {
    return this.secret;
  }

  /**
   * A new secret, and every address's tries start again. Only after a claim and for new letters asked for at the box:
   * the caller draws the screen again, so the link a person reads there is always the one that works.
   */
  rotate(): void {
    this.secret = newClaimLinkSecret(this.random);
    this.wrong.clear();
    this.onRotate?.();
  }

  /**
   * Whether `given`, shown by a visitor at `peer` (its address as the door saw it), is the link's secret. No link at
   * all is no try. A wrong one is a try of that address; the same wrong one again isn't another, so a page left open
   * on an old link costs its address one try, not one each time it connects. An address that used its tries is
   * refused unread, right link or not. Never changes the link and never touches the claim's own backoff.
   */
  check(given: string | undefined, peer: string): boolean {
    if (given === undefined) return false;
    const at = this.now();
    const tried = this.triedBy(peer, at);
    if (tried?.has(given)) return false;
    if (tried && tried.size >= CLAIM_LINK_TRIES_PER_PEER) return false;
    if (safeEqual(given, this.secret)) return true;
    this.remember(peer, given, at);
    return false;
  }

  /** Whether the address used its tries for now: no link it shows is read. */
  spent(peer: string): boolean {
    return (this.triedBy(peer, this.now())?.size ?? 0) >= CLAIM_LINK_TRIES_PER_PEER;
  }

  /** The address's wrong links of the last hour; older ones go here. */
  private triedBy(peer: string, at: number): Map<string, number> | undefined {
    const tried = this.wrong.get(peer);
    if (!tried) return undefined;
    for (const [link, since] of tried) if (at - since >= HOUR_MS) tried.delete(link);
    if (tried.size === 0) this.wrong.delete(peer);
    return tried.size ? tried : undefined;
  }

  private remember(peer: string, link: string, at: number): void {
    let tried = this.wrong.get(peer);
    if (!tried) {
      // Bounded: addresses with nothing left in the hour go first, then the one remembered longest. Forgetting gives
      // a stranger tries back, never takes any from the person.
      if (this.wrong.size >= CLAIM_LINK_PEERS)
        for (const known of [...this.wrong.keys()]) this.triedBy(known, at);
      if (this.wrong.size >= CLAIM_LINK_PEERS) {
        const oldest = this.wrong.keys().next().value;
        if (oldest !== undefined) this.wrong.delete(oldest);
      }
      tried = new Map();
      this.wrong.set(peer, tried);
    }
    tried.set(link, at);
  }
}
