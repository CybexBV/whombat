import { AVATAR_FACES, type AvatarFace } from '@whombat/avatars';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { FACTS } from '../facts';
import type { ClaimState, ReachLink, StartProblem } from '../lib/api';
import type { Client } from '../lib/client';
import {
  asksNewLetters,
  burrowNameSize,
  codeSize,
  countdown,
  type LinkScreen,
  lettersStayMinutes,
  liveLinkCode,
  minutesLeft,
  moreBurrows,
  noAddress,
  nowhereToType,
  type ReachNote,
  startWords,
} from '../lib/console';
import { CONSOLE, GUIDE_LABEL, SAY, WORD } from '../lib/copy';
import { FACT_EVERY_MS, FactRotation } from '../lib/facts';
import { Bubble, fill } from '../ui/Bubble';
import { Button } from '../ui/Button';
import { Confetti } from '../ui/Confetti';
import { Burrow } from '../ui/Wombat';
import { WaitingHint } from '../wifi/WifiLayer';
import styles from './console.module.css';

/** Starting and waiting: Hazel waking up in her burrow; while starting, why the first start can't finish (CG-409). */
export function Waking({ scene, start }: { scene: 'starting' | 'waiting'; start?: StartProblem }) {
  const waiting = scene === 'waiting';
  if (!waiting && start) {
    return (
      <WakingScene
        say={SAY.startProblem}
        title={WORD.startTitle}
        dots={false}
        hint={
          <>
            <p className={styles.wakingHint}>{startWords(start)}</p>
            <p className={styles.wakingHint}>{WORD.startRetry}</p>
          </>
        }
      />
    );
  }
  return (
    <WakingScene
      say={waiting ? SAY.waiting : SAY.starting}
      title={waiting ? WORD.waiting : WORD.starting}
      hint={
        waiting && (
          <WaitingHint
            className={styles.wakingHint}
            fallback={<p className={styles.wakingHint}>{WORD.waitingHint}</p>}
          />
        )
      }
    />
  );
}

/** Hazel in her burrow with what she says, the screen's title and a hint under it (the title's dots: still at it). */
function WakingScene({
  say,
  title,
  hint,
  dots = true,
}: {
  say: string;
  title: string;
  hint?: ReactNode;
  dots?: boolean;
}) {
  return (
    <div className={styles.waking}>
      <div className={styles.wakingScene}>
        <Burrow face="hazel" size={210} label={GUIDE_LABEL} />
        <Bubble tail="left" className={styles.wakingSay}>
          {say}
        </Bubble>
      </div>
      <h1 className={styles.wakingTitle}>
        {title}
        {dots && <span className={styles.dots} aria-hidden="true" />}
      </h1>
      {hint}
    </div>
  );
}

/**
 * Whombat Link starting, in place of the claim (CG-402, CG-404): its code on the claim's sign with where to type it,
 * or why there is none yet. The text console's words; no QR code (John).
 */
export function LinkStarting({ screen, link, now }: { screen: LinkScreen; link: ReachLink; now: number }) {
  if (screen === 'waiting') {
    return (
      <WakingScene
        say={SAY.linkWaiting}
        title={WORD.linkWaiting}
        hint={<p className={styles.wakingHint}>{WORD.linkWaitingHint}</p>}
      />
    );
  }
  const code = liveLinkCode(link, now);
  if (screen === 'starting' || !code) return <WakingScene say={SAY.linkStarting} title={WORD.linkStarting} />;
  return (
    <div className={styles.claim}>
      <h1 className={styles.claimTitle}>{WORD.linkTitle}</h1>
      <p className={styles.claimOpen}>{fill(WORD.linkOpen, <strong>{link.url}</strong>)}</p>
      <Sign
        text={code}
        size={codeSize(code.length)}
        label={`${CONSOLE.linkCode}: ${[...code].join(' ')}`}
        say={SAY.link}
        className={styles.linkSign}
      />
      <p className={styles.linkConfirm}>{WORD.linkConfirm}</p>
      {link.expiresAt && (
        <p className={styles.claimRotates}>{WORD.linkRotates(minutesLeft(link.expiresAt, now))}</p>
      )}
    </div>
  );
}

/** The sign Hazel and Banjo hold up, readable across a room. */
function Sign({
  text,
  size,
  label,
  say,
  wait = false,
  className = '',
}: {
  text: string;
  size: number;
  label: string;
  say: string;
  wait?: boolean;
  className?: string;
}) {
  return (
    <div className={`${styles.signScene} ${className}`}>
      <Burrow face="hazel" size={150} label={GUIDE_LABEL} className={styles.signLeft}>
        <Bubble tail="bottom-left" className={styles.signSay}>
          {say}
        </Bubble>
      </Burrow>
      <div className={styles.sign}>
        <div className={styles.board}>
          <span className="visually-hidden">{label}</span>
          <span
            className={`${styles.code} ${wait ? styles.wait : ''}`}
            style={{ fontSize: size }}
            aria-hidden="true"
          >
            {text}
          </span>
        </div>
        <span className={styles.post} />
        <span className={styles.post} />
      </div>
      <Burrow face="banjo" size={150} className={styles.signRight} />
    </div>
  );
}

/**
 * What Tailscale needs and Link's grace or end, above every claim screen (CG-404), in the text console's words and
 * order. The sign-in link is text, never a link or a QR code.
 */
export function ReachNotes({ notes }: { notes: ReachNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className={styles.notes} aria-label={CONSOLE.notes}>
      {notes.map((n) => (
        <li key={n.kind} className={styles.note}>
          {n.kind === 'tailscaleLogin'
            ? fill(WORD.tailscaleLogin, <strong className={styles.noteUrl}>{n.url}</strong>)
            : n.kind === 'tailscaleHttps'
              ? WORD.tailscaleHttps
              : n.kind === 'linkGrace'
                ? WORD.linkGrace(n.day)
                : WORD.linkEnded}
        </li>
      ))}
    </ul>
  );
}

/**
 * The claim code on a sign Hazel and Banjo hold up (CG-07, CG-35), readable across a room. No QR code here (John).
 * In backoff the sign shows the wait instead.
 */
export function Claimable({
  claim,
  backoff,
  now,
  line = 'claimNoAddress',
  client,
  refresh,
}: {
  claim: ClaimState;
  backoff: boolean;
  now: number;
  /** The line without an address (noAddressLine): Tailscale's steps while it asks for them. */
  line?: 'claimAfterTailscale' | 'claimAfterHttps' | 'claimNoAddress';
  /** For New letters; without it the screen only shows. */
  client?: Client;
  refresh?: () => void;
}) {
  if (!backoff && nowhereToType(claim)) {
    // No address a person can open yet (plain HTTP serves no page) and none for the app: no code, as there is nowhere
    // to type it.
    return (
      <div className={styles.claim}>
        <h1 className={styles.claimTitle}>{WORD.claimTitle}</h1>
        <p className={styles.claimOpen}>{WORD[line]}</p>
        {claim.ipv6Only && <p className={styles.claimOpen}>{WORD.claimIpv4}</p>}
        <Burrow face="hazel" size={150} label={GUIDE_LABEL} />
      </div>
    );
  }
  const text = backoff ? countdown(claim.retryAt, now) : claim.code;
  const size = backoff ? 150 : codeSize(claim.code.length);
  const stay = lettersStayMinutes(claim, now);
  return (
    <div className={styles.claim}>
      {backoff ? (
        <h1 className={styles.claimTitle}>{WORD.backoff(minutesLeft(claim.retryAt, now))}</h1>
      ) : (
        <>
          <h1 className={styles.claimTitle}>{WORD.claimTitle}</h1>
          <p className={styles.claimOpen}>
            {claim.inApp && noAddress(claim)
              ? fill(WORD.claimInApp, <strong>{claim.inApp}</strong>)
              : fill(
                  claim.onTailnet ? WORD.claimOpenTailnet : WORD.claimOpen,
                  <strong>{claim.claimUrl}</strong>,
                )}
          </p>
        </>
      )}
      <Sign
        text={text}
        size={size}
        label={backoff ? `${CONSOLE.retryIn} ${text}` : `${CONSOLE.claimCode}: ${[...text].join(' ')}`}
        say={backoff ? SAY.backoff : SAY.claimable}
        wait={backoff}
      />
      {!backoff && (
        <p className={styles.claimRotates}>{stay === null ? WORD.claimRotates : WORD.claimStays(stay)}</p>
      )}
      {claim.newLetters && client && <NewLetters client={client} refresh={refresh} />}
      {!backoff && <ClaimElse claim={claim} />}
    </div>
  );
}

/**
 * The other way in, last and quiet under the letters: the claim link above is on the internet, where others can keep
 * it busy, so the screen also names one they can't reach. The text console's words.
 */
function ClaimElse({ claim }: { claim: ClaimState }) {
  if (noAddress(claim)) return null;
  if (claim.fallbackTailnet)
    return (
      <p className={styles.claimElse}>
        {fill(WORD.claimElseTailnet, <strong>{claim.fallbackTailnet}</strong>)}
      </p>
    );
  if (claim.fallbackInApp)
    return (
      <p className={styles.claimElse}>{fill(WORD.claimElseInApp, <strong>{claim.fallbackInApp}</strong>)}</p>
    );
  return null;
}

/**
 * New letters (Whombat whombat-link.md): the person at the box asks for fresh letters that stay for a while, for when
 * others on the network used up the tries. A button for a finger or a mouse, and the N key as on the text console.
 */
function NewLetters({ client, refresh }: { client: Client; refresh?: (() => void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  const ask = useRef(() => {});
  ask.current = () => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    // The runtime writes the new letters to its state; the next read shows them. A refusal leaves the screen as it is.
    void client
      .post('/api/claim/letters', {})
      .catch(() => null)
      .then(() => {
        asking.current = false;
        setBusy(false);
        refresh?.();
      });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (asksNewLetters(e)) ask.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Button
      kind="secondary"
      className={styles.newLetters}
      disabled={busy}
      aria-keyshortcuts={CONSOLE.newLettersKey}
      onClick={() => ask.current()}
    >
      {CONSOLE.newLetters}
      {/* The key that does the same; a screen reader hears it from aria-keyshortcuts. */}
      <span className={styles.newLettersKey} aria-hidden="true">
        {CONSOLE.newLettersKey}
      </span>
    </Button>
  );
}

/** The fact that changes every minute with a fade; shuffled per start, no repeat until all were shown. */
function useFact(): { index: number; visible: boolean } {
  const rotation = useRef<FactRotation | null>(null);
  if (!rotation.current) rotation.current = new FactRotation(FACTS.length);
  const [index, setIndex] = useState(() => rotation.current?.next() ?? -1);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let swap: ReturnType<typeof setTimeout> | undefined;
    const t = setInterval(() => {
      setVisible(false);
      swap = setTimeout(() => {
        setIndex(rotation.current?.next() ?? -1);
        setVisible(true);
      }, 700);
    }, FACT_EVERY_MS);
    return () => {
      clearInterval(t);
      clearTimeout(swap);
    };
  }, []);
  return { index, visible };
}

/** The five wombat drawings in the handoff's order (CG-35, CG-338), sizes varied so the row doesn't look stamped. */
const FAMILY_SIZE: Record<AvatarFace, number> = {
  dusty: 108,
  banjo: 128,
  neo: 116,
  skipper: 132,
  hazel: 110,
};

/**
 * Claimed: the burrow's name, the app's address, a wombat fact; the five sit still (CG-08). With a note above it
 * (Link's grace or end, Tailscale, CG-404) the fact makes room for the note.
 */
export function Claimed({ claim, noted = false }: { claim: ClaimState; noted?: boolean }) {
  const { index, visible } = useFact();
  const fact = FACTS[index];
  const name = claim.burrows?.first ?? null;
  const more = claim.burrows ? moreBurrows(claim.burrows.more) : null;
  return (
    <div className={styles.claimed}>
      <div className={styles.claimedText}>
        {name ? (
          <>
            <p className={styles.setUp}>{WORD.claimed}</p>
            <h1 className={styles.burrowName} style={{ fontSize: burrowNameSize(name) }}>
              {name}
            </h1>
            {more && <p className={styles.more}>{more}</p>}
          </>
        ) : (
          <h1 className={styles.burrowName} style={{ fontSize: 64 }}>
            {WORD.claimed}
          </h1>
        )}
        <p className={styles.openApp}>{claim.appUrl ? WORD.claimedOpen(claim.appUrl) : WORD.claimedApp}</p>
      </div>
      {fact && !noted && (
        <figure className={styles.fact} style={{ opacity: visible ? 1 : 0 }} aria-live="polite">
          <figcaption className={styles.factKicker}>{CONSOLE.factKicker}</figcaption>
          <blockquote className={styles.factText}>{fact.text}</blockquote>
        </figure>
      )}
      <div className={styles.family} aria-hidden="true">
        {AVATAR_FACES.map((face) => (
          <Burrow key={face} face={face} size={FAMILY_SIZE[face]} />
        ))}
      </div>
    </div>
  );
}

/** The moment of the claim: confetti and Hazel, a few seconds (CG-07). */
export function Celebration({ claim }: { claim: ClaimState }) {
  return (
    <div className={styles.celebration} role="status">
      <Confetti />
      <div className={styles.celebrationScene}>
        <Bubble tail="bottom-left" className={styles.celebrationSay}>
          {SAY.celebrate}
        </Bubble>
        <Burrow face="hazel" size={250} label={GUIDE_LABEL} />
      </div>
      <h1 className={styles.celebrationTitle}>{CONSOLE.claimed}</h1>
      {claim.burrows && <p className={styles.celebrationName}>{claim.burrows.first}</p>}
    </div>
  );
}
