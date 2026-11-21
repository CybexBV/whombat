/**
 * The page a shared link opens (docs/decisions/share-links.md): the hosted app's `/s/<id>#<key>`. It fetches the sealed
 * copy from control, opens it here with the key from the fragment (which never left the browser) and shows it read-only.
 * No sign-in, no session with any Whombat, nothing to reply with.
 */
import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';
import { AgentFace, initialsOf } from '@whombat/core';
import { openSnapshot, parseShareLocation, type SharedSnapshot, sharePublicPath } from '@whombat/core/share';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { HtmlPreviewCard } from '../features/messaging/HtmlPreview';
import { RichText } from '../features/messaging/RichText';
import styles from './SharedView.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'incomplete' }
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'offline' }
  | { kind: 'ready'; snapshot: SharedSnapshot };

/** Loads and opens the copy the location names. `fetchBytes` answers null for a link control no longer keeps. */
export async function loadShared(
  location: { pathname: string; hash: string },
  fetchBytes: (id: string) => Promise<Uint8Array | null>,
): Promise<State> {
  const at = parseShareLocation(location.pathname, location.hash);
  if (!at) return { kind: 'incomplete' };
  let bytes: Uint8Array | null;
  try {
    bytes = await fetchBytes(at.id);
  } catch {
    return { kind: 'offline' };
  }
  if (!bytes) return { kind: 'gone' };
  const snapshot = openSnapshot(bytes, at.id, at.key);
  return snapshot ? { kind: 'ready', snapshot } : { kind: 'unreadable' };
}

/** The copy's bytes from control; null on 404 (stopped or expired). */
export function controlFetcher(controlUrl: string) {
  const base = controlUrl.replace(/\/+$/, '');
  return async (id: string): Promise<Uint8Array | null> => {
    const res = await fetch(`${base}${sharePublicPath(id)}`, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`share ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function Notice({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }) {
  return (
    <main className={styles.notice}>
      <h1 className={styles.noticeTitle}>{title}</h1>
      <p className={styles.noticeText}>{text}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </main>
  );
}

export function SharedConversation({ snapshot }: { snapshot: SharedSnapshot }) {
  const pictures = useMemo(
    () => new Map(snapshot.pictures.map((p) => [p.id, `data:${p.mime};base64,${toBase64(p.data)}`])),
    [snapshot],
  );
  const face = AgentFace.safeParse(snapshot.assistant.face);
  const personInitials = initialsOf(snapshot.person.name);
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <p className={styles.kicker}>Shared conversation</p>
        <h1 className={styles.title}>{snapshot.title}</h1>
        <p className={styles.meta}>
          {snapshot.person.name} shared this on {dayFormat.format(snapshot.sharedAt)}
        </p>
      </header>
      <ol className={styles.messages}>
        {snapshot.messages.map((m, i) => {
          const name = m.from === 'person' ? snapshot.person.name : snapshot.assistant.name;
          return (
            // A snapshot never changes, so its order is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: the copy is frozen
            <li key={i} className={styles.message}>
              {m.from === 'person' ? (
                <HumanAvatar initials={personInitials} size={40} />
              ) : (
                <WhombatAvatar face={face.success ? face.data : 'dusty'} size={40} />
              )}
              <div className={styles.content}>
                <p className={styles.line}>
                  <span className={styles.name}>{name}</span>
                  <time className={styles.time} dateTime={new Date(m.at).toISOString()}>
                    {timeFormat.format(m.at)}
                  </time>
                </p>
                {m.text && <RichText text={m.text} />}
                {m.pictures?.map((id) => {
                  const src = pictures.get(id);
                  return src ? <img key={id} className={styles.picture} src={src} alt="" /> : null;
                })}
                {m.pages?.map((page, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the copy is frozen
                  <HtmlPreviewCard key={j} html={page.html} fallbackTitle={page.title} />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <footer className={styles.foot}>
        A copy {snapshot.person.name} shared from Whombat. It doesn’t change when the conversation goes on.
      </footer>
    </main>
  );
}

/** base64url → base64 for a data URL. */
function toBase64(data: string): string {
  const b = data.replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - (b.length % 4)) % 4);
}

export function SharedView({ fetchBytes }: { fetchBytes: (id: string) => Promise<Uint8Array | null> }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void loadShared(window.location, fetchBytes).then(setState);
  }, [fetchBytes]);
  useEffect(load, [load]);
  useEffect(() => {
    document.title =
      state.kind === 'ready' ? `${state.snapshot.title} · Whombat` : 'Shared conversation · Whombat';
  }, [state]);
  switch (state.kind) {
    case 'loading':
      return <main className={styles.notice} aria-busy="true" />;
    case 'incomplete':
      return (
        <Notice
          title="This link isn’t complete"
          text="Part of it is missing. Ask the person who sent it to send the whole link again."
        />
      );
    case 'gone':
      return (
        <Notice
          title="This link has stopped working"
          text="The person who shared it stopped sharing it, or it ran out."
        />
      );
    case 'unreadable':
      return (
        <Notice
          title="This link doesn’t open"
          text="Part of it may have been changed. Ask the person who sent it to send it again."
        />
      );
    case 'offline':
      return <Notice title="Couldn’t load this" text="Check your connection and try again." onRetry={load} />;
    case 'ready':
      return <SharedConversation snapshot={state.snapshot} />;
  }
}
