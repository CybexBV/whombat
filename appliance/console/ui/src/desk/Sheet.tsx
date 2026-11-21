/**
 * Answering on the screen (mockup 2, DK-04, DK-05, DK-60…DK-62, TF-14, TF-15): the ask sheet and the PIN pad beside it
 * while locked. Approve says the ask's own words and acts once; the web card's wider choices (“Don’t ask again on Home
 * Assistant”) follow it, each after the PIN; Deny is the person's no and Not now a snooze. A risky ask's Approve asks
 * for the PIN again (the approve pad beside the card); on a runtime from before 0.108, asks Whombat keeps for the phone
 * have no buttons here. The header names who asks.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../lib/client';
import { countdown, minutesLeft } from '../lib/console';
import type { DecideAnswer, Decision } from '../lib/decide';
import type {
  AgentFace,
  DeskAsk,
  DeskAskChoice,
  DeskLock,
  DeskLook,
  DeskPaired,
  LookQuietHow,
} from '../lib/desk';
import { ago, DESK, DESK_WORDS, fill, wrongPinText } from '../lib/deskCopy';
import { askShown } from '../lib/deskScene';
import { lookActions, lookDetail, lookStage, quietDone, researchSays, researchTitle } from '../lib/needsYou';
import {
  backoffUntil,
  padMessage,
  parsePhoneAnswer,
  parseUnlockAnswer,
  pressKey,
  type UnlockAnswer,
} from '../lib/unlock';
import styles from './desk.module.css';
import { Icon } from './icons';
import { Face } from './parts';

/** The dimmed glance behind a sheet and the amber edge; a tap on it closes the sheet. */
export function Scrim({ onClose, glow }: { onClose: () => void; glow: boolean }) {
  return (
    <>
      <button
        type="button"
        className={styles.scrim}
        aria-label={DESK.close}
        tabIndex={-1}
        onClick={onClose}
      />
      {glow && <div className={styles.glow} />}
    </>
  );
}

export function SheetGrid({ children, one }: { children: ReactNode; one: boolean }) {
  return (
    <div className={styles.sheet}>
      <div className={styles.sheetGrid} data-one={one || undefined}>
        {children}
      </div>
    </div>
  );
}

export interface AskCardProps {
  ask: DeskAsk;
  /** It was answered somewhere else while the sheet was open. */
  gone: boolean;
  assistant: { name: string; face: AgentFace };
  /** Server clock (ms). */
  now: number;
  /** The screen isn't unlocked now: the title only, no buttons (CG-50). */
  locked: boolean;
  /** Talk is on (the Ask and Answer buttons). */
  voice: boolean;
  busy: boolean;
  note: string | null;
  /** “2 of 3” among the asks that came (DK-60), or null. */
  place?: { n: number; m: number } | null;
  /** Approve, Deny (the person's no, DK-61) or Not now (a snooze until tomorrow, DK-S19). */
  onDecide: (decision: Decision) => void;
  /** A risky ask's Approve (DK-62): the approve pad opens beside the card. */
  onApproveWithPin?: () => void;
  /** One of the ask's wider choices (TF-14): the approve pad opens beside the card for it. */
  onChoose?: (choice: DeskAskChoice) => void;
  /** Opens Talk about it. */
  onTalk: () => void;
  onClose: () => void;
}

export function AskCard(p: AskCardProps) {
  const { assistant, now, busy } = p;
  // What may show now: locked, never the ask's words or its buttons, whatever the page still holds (CG-50).
  const { ask, actions, talk } = askShown(p.ask, { unlocked: !p.locked, gone: p.gone, voice: p.voice });
  const act = (f: () => void) => () => {
    if (!busy) f();
  };
  // Busy, the buttons wait.
  const wait = busy || undefined;
  // A risky ask on a runtime from 0.108 (DK-61, DK-62): Deny and Not now here, Approve with the PIN or on the phone.
  const risky = actions === 'phone' && p.ask.deny === true;
  const talkHere = risky ? p.voice && !p.locked : talk;
  const deny = p.ask.deny === true && (
    <button
      type="button"
      className={styles.btn}
      aria-disabled={busy}
      data-busy={wait}
      onClick={act(() => p.onDecide('deny'))}
    >
      {DESK_WORDS.deny}
    </button>
  );
  const askTalk = talkHere && (
    <button
      type="button"
      className={styles.btn}
      aria-disabled={busy}
      data-busy={wait}
      onClick={act(p.onTalk)}
    >
      {DESK_WORDS.ask}
    </button>
  );
  const notNow = (
    <button
      type="button"
      className={styles.btn}
      aria-disabled={busy}
      data-busy={wait}
      onClick={act(() => p.onDecide('decline'))}
    >
      {DESK_WORDS.notNow}
    </button>
  );
  // The web card's wider choices (TF-14, CG-280): right after Approve, in the web's order, each a row of its own with the
  // lock that says the PIN comes first.
  const choices = ask.choices ?? [];
  const choiceButtons = choices.map((c) => (
    <button
      key={c.scope}
      type="button"
      className={`${styles.btn} ${styles.btnChoice}`}
      aria-disabled={busy}
      data-busy={wait}
      data-scope={c.scope}
      onClick={act(() => p.onChoose?.(c))}
    >
      <Icon name="lock" />
      <span className={styles.btnChoiceLabel}>{c.label}</span>
    </button>
  ));
  const many = choices.length > 0 || undefined;
  let footer: ReactNode = null;
  if (risky && p.locked) {
    footer = <p className={styles.lockedNote}>{DESK.unlockToAnswer}</p>;
  } else if (risky) {
    const why =
      ask.phoneReason && fill(DESK_WORDS.phoneReasons[ask.phoneReason], { assistant: assistant.name });
    footer = ask.approveWithPin ? (
      <>
        {why && (
          <p className={styles.riskNote}>
            <Icon name="lock" />
            {why}
          </p>
        )}
        <div className={styles.buttons} data-many={(talkHere && deny) || many}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            aria-disabled={busy}
            data-busy={wait}
            onClick={act(() => p.onApproveWithPin?.())}
          >
            <span className={styles.btnLabel}>{ask.approveLabel ?? DESK_WORDS.approve}</span>
          </button>
          {choiceButtons}
          {deny}
          {notNow}
          {askTalk}
        </div>
      </>
    ) : (
      <>
        <p className={`${styles.onPhoneText} ${styles.riskPhone}`}>
          <Icon name="phone" />
          <span>
            {DESK_WORDS.approveOnPhone}
            {why && <span className={styles.onPhoneWhy}>{why}</span>}
          </span>
        </p>
        <div className={styles.buttons}>
          {deny}
          {notNow}
          {askTalk}
        </div>
      </>
    );
  } else if (actions === null) {
    // Locked: what unlocking is for, in place of the words and the buttons.
    footer = <p className={styles.lockedNote}>{DESK.unlockToAnswer}</p>;
  } else if (actions === 'gone') {
    footer = (
      <div className={styles.buttons}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={p.onClose}>
          {DESK.close}
        </button>
      </div>
    );
  } else if (actions === 'phone') {
    footer = (
      <div className={styles.onPhone}>
        <span className={styles.onPhoneText}>
          <Icon name="phone" />
          <span>
            {DESK_WORDS.onPhone}
            {ask.phoneReason && (
              <span className={styles.onPhoneWhy}>
                {fill(DESK_WORDS.phoneReasons[ask.phoneReason], { assistant: assistant.name })}
              </span>
            )}
          </span>
        </span>
        <button type="button" className={styles.btn} onClick={p.onClose}>
          {DESK.close}
        </button>
      </div>
    );
  } else if (actions === 'question') {
    footer = (
      <div className={styles.buttons}>
        {talk && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            aria-disabled={busy}
            data-busy={wait}
            onClick={act(p.onTalk)}
          >
            {DESK.answer}
          </button>
        )}
        {notNow}
      </div>
    );
  } else if (actions === 'approval') {
    footer = (
      <div className={styles.buttons} data-many={(talk && deny) || many}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          aria-disabled={busy}
          data-busy={wait}
          onClick={act(() => p.onDecide('approve'))}
        >
          <span className={styles.btnLabel}>{ask.approveLabel ?? DESK_WORDS.approve}</span>
        </button>
        {choiceButtons}
        {deny}
        {notNow}
        {askTalk}
      </div>
    );
  }
  const from = ask.from ?? assistant.name;
  return (
    // Locked, the card is as tall as what it says, level with the top of the PIN pad.
    <section
      className={`${styles.card} ${styles.askCard}`}
      data-locked={p.locked || undefined}
      aria-label={ask.title}
    >
      <div className={styles.who}>
        {/* A person asks (TF-15, CG-282): their initial, not the agent's face. */}
        {from === assistant.name ? (
          <Face face={assistant.face} size={44} />
        ) : (
          <span className={styles.fromFace} aria-hidden="true">
            {([...from][0] ?? '?').toUpperCase()}
          </span>
        )}
        <div>
          <b className={styles.whoName}>{fill(DESK_WORDS.asks, { assistant: from })}</b>
          <br />
          <span className={styles.whoMeta}>
            {ago(ask.at, now, true)}
            {ask.where && ` · ${ask.where}`}
          </span>
        </div>
        {p.place && <span className={styles.askPlace}>{fill(DESK.askOf, p.place)}</span>}
      </div>
      <h2 className={styles.askHeading}>{ask.title}</h2>
      {ask.detail && <p className={styles.askDetail}>{ask.detail}</p>}
      {ask.facts.length > 0 && (
        <div className={styles.facts}>
          {ask.facts.map((f) => (
            <span key={f} className={styles.fact}>
              {f}
            </span>
          ))}
        </div>
      )}
      {(p.gone || p.note) && <p className={styles.sheetNote}>{p.gone ? DESK.alreadyAnswered : p.note}</p>}
      {footer}
    </section>
  );
}

export interface LookCardProps {
  look: DeskLook;
  /** It is fine again: it left Needs you while the card was open (DK-95). */
  gone: boolean;
  assistant: { name: string; face: AgentFace };
  /** Ignore or Not now is on its way: the buttons wait. */
  busy?: boolean;
  /** Whombat refused Ignore or Not now, in plain words (CG-334). */
  note?: string | null;
  /** Ignore or Not now went through: the card says so, then closes (QN-20). */
  done?: LookQuietHow | null;
  /**
   * The PIN pad is beside the card for Ignore, Not now or the assistant's step (locked): that button shows chosen, the
   * card level with the pad.
   */
  pending?: LookQuietHow | 'fix' | null;
  /**
   * *Ask {assistant} to look into it* (DK-96, QN-20), or *Ask {assistant}* once it found out (3.5, CG-375): Talk with
   * the question, after the PIN when locked.
   */
  onFix: () => void;
  /** The step the assistant offers (3.5, CG-375): its go-ahead, after the PIN when locked. */
  onStep?: () => void;
  /** *Ignore* or *Not now* (QN-20): after the PIN when locked. */
  onQuiet?: (how: LookQuietHow) => void;
  /** *Open {name}*: a server's screen (DK-83); absent when it has none. */
  onOpen?: () => void;
  onClose: () => void;
}

/**
 * Something that needs a look (DK-95, QN-20), as an ask's card: “{assistant} noticed” and what it is, the title, why (or
 * that the assistant doesn't know yet), then the buttons by what kind of line it is (CG-333): a problem *Ask {assistant}
 * to look into it*, *Ignore* (when you'll hear again under it) and *Not now*; only you *Ignore* and *Not now*; *Open
 * {name}* for a server. A look from a runtime before 0.122 can't be quieted here: Ask, Open and *Close*. Locked too: it
 * says nothing a server card doesn't, and every button but Open and Close asks for the PIN first. Fine again: Close
 * only. Ignored or put off: what happens now, and the card closes. A look the assistant looked into (3.5, CG-375): the
 * hero's words (“I’m looking into it.”, its title and summary, “I’m on it.”, fixed with a check), and once found its
 * step on a row of its own, then *Ignore*, *Not now*, *Ask {assistant}* and *Open*.
 */
export function LookCard({
  look,
  gone,
  assistant,
  busy = false,
  note = null,
  done = null,
  pending = null,
  onFix,
  onStep,
  onQuiet,
  onOpen,
  onClose,
}: LookCardProps) {
  const { fix, quiet: mayQuiet, step: stepLabel, ask } = lookActions(look);
  const quiet = mayQuiet && onQuiet !== undefined;
  const step = onStep ? stepLabel : null;
  const stage = lookStage(look);
  const act = (f: () => void) => () => {
    if (!busy) f();
  };
  const wait = busy || undefined;
  let footer: ReactNode = null;
  if (gone && !done) {
    footer = (
      <div className={styles.buttons}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>
          {DESK.close}
        </button>
      </div>
    );
  } else if (!done) {
    const words = look.ignoreWords;
    footer = (
      // Ask on a row of its own when two or more share the row under it (CG-280); Ignore, Not now and Open share theirs.
      <div
        className={styles.buttons}
        data-many={quiet || ((fix || step !== null) && (onOpen !== undefined || ask)) || undefined}
        data-quiet={quiet || undefined}
      >
        {step !== null && onStep && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            aria-disabled={busy}
            aria-pressed={pending === null ? undefined : pending === 'fix'}
            data-busy={wait}
            onClick={act(onStep)}
          >
            <span className={styles.btnLabel}>{step}</span>
          </button>
        )}
        {fix && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            aria-disabled={busy}
            data-busy={wait}
            onClick={act(onFix)}
          >
            <span className={styles.btnLabel}>
              {fill(DESK_WORDS.looks.fix, { assistant: assistant.name })}
            </span>
          </button>
        )}
        {quiet && (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnIgnore}`}
            aria-disabled={busy}
            aria-pressed={pending === null ? undefined : pending === 'ignore'}
            data-busy={wait}
            onClick={act(() => onQuiet('ignore'))}
          >
            <span className={styles.btnLabel}>{DESK_WORDS.looks.ignore}</span>
            {words && <span className={styles.btnSub}>{words}</span>}
          </button>
        )}
        {quiet && (
          <button
            type="button"
            className={styles.btn}
            aria-disabled={busy}
            aria-pressed={pending === null ? undefined : pending === 'snooze'}
            data-busy={wait}
            onClick={act(() => onQuiet('snooze'))}
          >
            <span className={styles.btnLabel}>{DESK_WORDS.looks.notNow}</span>
          </button>
        )}
        {ask && (
          <button
            type="button"
            className={styles.btn}
            aria-disabled={busy}
            data-busy={wait}
            onClick={act(onFix)}
          >
            <span className={styles.btnLabel}>
              {fill(DESK_WORDS.looks.ask, { assistant: assistant.name })}
            </span>
          </button>
        )}
        {onOpen && (
          <button type="button" className={styles.btn} onClick={onOpen}>
            <span className={styles.btnLabel}>{fill(DESK_WORDS.looks.open, { name: look.name })}</span>
          </button>
        )}
        {/* With Not now there is no Close: a touch beside the card or Escape closes it, as an ask's (CG-333). */}
        {!quiet && (
          <button type="button" className={styles.btn} onClick={onClose}>
            {DESK.close}
          </button>
        )}
      </div>
    );
  }
  return (
    <section
      className={`${styles.card} ${styles.askCard}`}
      data-locked={pending !== null || undefined}
      aria-label={researchTitle(look)}
    >
      <div className={styles.who}>
        <Face face={assistant.face} size={44} />
        <div>
          <b className={styles.whoName}>{fill(DESK_WORDS.looks.noticed, { assistant: assistant.name })}</b>
          <br />
          <span className={styles.whoMeta}>{DESK_WORDS.looks.kinds[look.kind]}</span>
        </div>
      </div>
      <h2 className={styles.askHeading}>{researchTitle(look)}</h2>
      {stage ? (
        <p className={styles.askDetail} data-research={stage}>
          {(stage === 'looking' || stage === 'fixing') && (
            <span className={styles.spinner} aria-hidden="true" />
          )}
          {stage === 'fixed' && <Icon name="check" className={styles.fixedIcon} />}
          {researchSays(look, stage, lookDetail(look))}
        </p>
      ) : (
        <p className={styles.askDetail}>{lookDetail(look) ?? DESK_WORDS.looks.noReason}</p>
      )}
      {done ? (
        <p className={styles.quietDone} role="status">
          <Icon name="check" />
          {quietDone(done)}
        </p>
      ) : (
        (gone || note) && <p className={styles.sheetNote}>{gone ? DESK_WORDS.looks.fine : note}</p>
      )}
      {footer}
    </section>
  );
}

export interface PinPadProps {
  person: DeskPaired['person'];
  /** False: no PIN chosen yet, the pad has only the phone (DK-18). */
  hasPin: boolean;
  /** The PIN's digits (4 to 6, DK-26; `pinLength`): that many dots, sent at the last. */
  length: number;
  lock: DeskLock;
  /** Server clock (ms). */
  now: number;
  client: Client;
  refresh: () => void;
  onCancel: () => void;
  /** Fixtures and a key typed on the locked glance. */
  initialDigits?: string;
  /** Why the pad opened by itself (DK-60): “Neo needs your answer.” above it. */
  reason?: string | null;
}

/** The PIN pad (DK-04, DK-26): the PIN's 4 to 6 digits, Cancel and Delete, “or confirm on your phone”. Keys work too. */
export function PinPad({
  person,
  hasPin: sentHasPin,
  length,
  lock,
  now,
  client,
  refresh,
  onCancel,
  initialDigits = '',
  reason = null,
}: PinPadProps) {
  const [digits, setDigits] = useState(initialDigits);
  const [last, setLast] = useState<UnlockAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const [phoneUntil, setPhoneUntil] = useState<string | null>(null);
  const [phoneEnded, setPhoneEnded] = useState(false);

  // Whombat refusing a PIN because there is none (a runtime that sent no `hasPin`) means the same as `hasPin: false`.
  const hasPin = sentHasPin && last?.result !== 'noPin';
  const waitUntil = backoffUntil(lock, last, now);
  const phoneAt = lock.state === 'phone' && lock.expiresAt ? lock.expiresAt : phoneUntil;
  const phoneLive = phoneAt !== null && Date.parse(phoneAt) > now;

  // The phone's time ran out, or the person said No there: back to the PIN, saying so.
  useEffect(() => {
    if (phoneUntil && Date.parse(phoneUntil) <= now) {
      setPhoneUntil(null);
      setPhoneEnded(true);
    }
  }, [phoneUntil, now]);
  const sawPhone = useRef(false);
  useEffect(() => {
    if (lock.state === 'phone') sawPhone.current = true;
    else if (sawPhone.current) {
      sawPhone.current = false;
      setPhoneUntil(null);
      if (lock.state === 'locked') setPhoneEnded(true);
    }
  }, [lock.state]);

  // The digits and the wait as refs too: keys typed faster than React renders all count.
  const digitsRef = useRef(initialDigits);
  const busyRef = useRef(false);
  const blocked = useRef(false);
  blocked.current = waitUntil !== null;

  const submit = useCallback(
    (pin: string) => {
      busyRef.current = true;
      setBusy(true);
      client
        .post('/api/desk/unlock', { pin })
        .then(
          (res) => parseUnlockAnswer(res.status, res.body),
          (): UnlockAnswer => ({ result: 'failed' }),
        )
        .then((a) => {
          setLast(a);
          digitsRef.current = '';
          setDigits('');
          busyRef.current = false;
          setBusy(false);
          if (a.result === 'unlocked') refresh();
          else setShake((s) => s + 1);
        });
    },
    [client, refresh],
  );

  const press = useCallback(
    (key: string) => {
      if (busyRef.current || blocked.current) return;
      const next = pressKey(digitsRef.current, key, length);
      if (next === digitsRef.current) return;
      setPhoneEnded(false);
      digitsRef.current = next;
      setDigits(next);
      if (next.length === length) submit(next);
    },
    [submit, length],
  );

  // The PIN was chosen again meanwhile with another length: the digits typed start over.
  const typedFor = useRef(length);
  useEffect(() => {
    if (typedFor.current === length) return;
    typedFor.current = length;
    digitsRef.current = '';
    setDigits('');
  }, [length]);

  useEffect(() => {
    if (phoneLive) return;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') onCancel();
      else if (!hasPin)
        return; // no PIN to type (DK-18)
      else if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('delete');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [press, onCancel, phoneLive, hasPin]);

  const askPhone = async () => {
    setPhoneEnded(false);
    const res = await client.post('/api/desk/unlock/phone', {}).catch(() => null);
    const until = res ? parsePhoneAnswer(res.status, res.body) : null;
    if (until) setPhoneUntil(until);
    refresh();
  };

  const unlockAs = fill(DESK_WORDS.unlockAs, { name: person.name });
  const face = (
    <span className={styles.pinFace} style={{ background: `var(--tone-${person.tone})` }} aria-hidden="true">
      {person.initial}
    </span>
  );

  if (phoneLive && phoneAt) {
    return (
      <section className={`${styles.card} ${styles.pin}`} data-phone aria-live="polite">
        <span className={styles.phoneIcon}>
          <Icon name="phone" />
        </span>
        <p className={styles.pinTitle}>{DESK_WORDS.checkPhone}</p>
        <p className={styles.phoneHow}>{DESK.phoneHow}</p>
        <span className={styles.phoneLeft}>{countdown(phoneAt, now)}</span>
        <button
          type="button"
          className={styles.pinAlt}
          onClick={() => {
            setPhoneUntil(null);
            onCancel();
          }}
        >
          {DESK_WORDS.cancel}
        </button>
      </section>
    );
  }

  // No PIN yet (DK-18): only the phone unlocks, and the pad says where a PIN is chosen.
  if (!hasPin) {
    return (
      <section className={`${styles.card} ${styles.pin}`} data-no-pin aria-label={unlockAs}>
        {face}
        <p className={styles.pinTitle} data-error={phoneEnded ? '' : undefined} aria-live="polite">
          {phoneEnded ? DESK_WORDS.phoneSaidNo : unlockAs}
        </p>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.pinPhone}`}
          onClick={() => void askPhone()}
        >
          <Icon name="phone" />
          {DESK_WORDS.confirmOnPhone}
        </button>
        <p className={styles.noPinYet}>{DESK_WORDS.noPinYet}</p>
        <button type="button" className={styles.pinAlt} onClick={onCancel}>
          {DESK_WORDS.cancel}
        </button>
      </section>
    );
  }

  const message = phoneEnded
    ? DESK_WORDS.phoneSaidNo
    : last?.result === 'failed'
      ? DESK_WORDS.talkFailed
      : padMessage(lock, last, now);
  const locked = waitUntil !== null || busy;
  return (
    <section className={`${styles.card} ${styles.pin}`} aria-label={unlockAs}>
      {reason && <p className={styles.pinReason}>{reason}</p>}
      {face}
      <p className={styles.pinTitle} data-error={message ? '' : undefined} aria-live="polite">
        {message ?? unlockAs}
      </p>
      <Keypad
        digits={digits.length}
        length={length}
        shake={shake}
        disabled={locked}
        onPress={press}
        onCancel={onCancel}
      />
      <button type="button" className={styles.pinAlt} onClick={() => void askPhone()}>
        {DESK_WORDS.orConfirmOnPhone}
      </button>
    </section>
  );
}

/** The PIN's dots and the keys (DK-04, DK-26): digits, Cancel, 0, Delete. */
function Keypad(p: {
  digits: number;
  length: number;
  shake: number;
  disabled: boolean;
  onPress: (key: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className={styles.dots} key={p.shake} data-shake={p.shake > 0 || undefined} aria-hidden="true">
        {Array.from({ length: p.length }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the PIN's fixed dots
          <i key={i} className={styles.pinDot} data-on={i < p.digits || undefined} />
        ))}
      </div>
      <div className={styles.keys}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button
            key={k}
            type="button"
            className={styles.key}
            disabled={p.disabled}
            onClick={() => p.onPress(k)}
          >
            {k}
          </button>
        ))}
        <button type="button" className={`${styles.key} ${styles.keyText}`} onClick={p.onCancel}>
          {DESK_WORDS.cancel}
        </button>
        <button type="button" className={styles.key} disabled={p.disabled} onClick={() => p.onPress('0')}>
          0
        </button>
        <button
          type="button"
          className={`${styles.key} ${styles.keyText}`}
          disabled={p.disabled}
          onClick={() => p.onPress('delete')}
        >
          {DESK_WORDS.delete}
        </button>
      </div>
    </>
  );
}

export interface ApprovePadProps {
  /** The PIN's digits (4 to 6, `pinLength`). */
  length: number;
  /** Server clock (ms): the wait's minutes. */
  now: number;
  /** Sends the PIN with Approve; the pad shows a wrong PIN or the wait, the sheet acts on the rest. */
  onPin: (pin: string) => Promise<DecideAnswer>;
  onResult: (a: DecideAnswer) => void;
  onCancel: () => void;
  /** The pad's line: a wider choice's (“Type your PIN for “Don’t ask again on Home Assistant”.”, TF-14). */
  title?: string;
  /** Fixtures. */
  initialDigits?: string;
}

/**
 * A risky ask's Approve (DK-62), or one of an ask's wider choices (TF-14): the PIN typed again beside the card, sent
 * with the decision. Whombat checks it as an unlock's: a wrong one counts, five and the screen waits (and locks). Keys
 * work too; Escape cancels.
 */
export function ApprovePad({
  length,
  now,
  onPin,
  onResult,
  onCancel,
  title = DESK_WORDS.approveWithPin,
  initialDigits = '',
}: ApprovePadProps) {
  const [digits, setDigits] = useState(initialDigits);
  const [last, setLast] = useState<DecideAnswer | null>(null);
  const [shake, setShake] = useState(0);
  const digitsRef = useRef(initialDigits);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const waitUntil =
    last?.result === 'backoff' && last.retryAt && Date.parse(last.retryAt) > now ? last.retryAt : null;
  const blocked = useRef(false);
  blocked.current = waitUntil !== null;

  const press = useCallback(
    (key: string) => {
      if (busyRef.current || blocked.current) return;
      const next = pressKey(digitsRef.current, key, length);
      if (next === digitsRef.current) return;
      digitsRef.current = next;
      setDigits(next);
      if (next.length < length) return;
      busyRef.current = true;
      setBusy(true);
      void onPin(next).then((a) => {
        busyRef.current = false;
        setBusy(false);
        digitsRef.current = '';
        setDigits('');
        if (a.result === 'wrong' || a.result === 'backoff' || a.result === 'failed') {
          setLast(a);
          setShake((s) => s + 1);
        } else onResult(a);
      });
    },
    [length, onPin, onResult],
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') onCancel();
      else if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('delete');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [press, onCancel]);

  const message = waitUntil
    ? fill(DESK_WORDS.tooManyPins, { m: minutesLeft(waitUntil, now) })
    : last?.result === 'wrong'
      ? last.triesLeft === null
        ? DESK.wrongPin
        : wrongPinText(last.triesLeft)
      : last?.result === 'failed'
        ? DESK_WORDS.talkFailed
        : null;
  return (
    <section className={`${styles.card} ${styles.pin}`} data-approve aria-label={title}>
      <span className={styles.phoneIcon}>
        <Icon name="lock" />
      </span>
      <p className={styles.pinTitle} data-error={message ? '' : undefined} aria-live="polite">
        {message ?? title}
      </p>
      <Keypad
        digits={digits.length}
        length={length}
        shake={shake}
        disabled={busy || waitUntil !== null}
        onPress={press}
        onCancel={onCancel}
      />
    </section>
  );
}
