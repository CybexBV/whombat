/**
 * Small pieces the servers' pages share (AP-1306): an in-app link, a card with its head, a dot, a badge, a guest's
 * state, a tag, the line a refusal or an empty list says, a confirmation, and the toast after a change.
 */
import type { CommitResult } from '@whombat/client';
import { commitOutcomeText, type HostTone, hostErrorInfo } from '@whombat/client/hosts';
import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useCallback, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Modal, ModalTitle } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import styles from './Things.module.css';

/** A link inside the app: a plain click navigates without a reload, a modified click opens a tab. */
export function AppLink({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const navigate = useNavigateHref();
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}

export function Card({
  title,
  meta,
  link,
  children,
  id,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  /** The head's link on the right (“All 23 guests”). */
  link?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section
      className={cx(styles.card, className)}
      id={id}
      aria-labelledby={id && title ? `${id}-title` : undefined}
    >
      {title || link ? (
        <header className={styles.cardHead}>
          {title ? <h2 id={id ? `${id}-title` : undefined}>{title}</h2> : null}
          {meta ? <span className={styles.meta}>{meta}</span> : null}
          {link}
        </header>
      ) : null}
      {children}
    </section>
  );
}

const DOT: Record<HostTone, string | undefined> = {
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
  mut: styles.mut,
};

/** A status dot; `label` names it for screen readers when no word beside it says the same. */
export function Dot({ tone, label }: { tone: HostTone; label?: string }) {
  if (label) return <span className={cx(styles.dot, DOT[tone])} role="img" aria-label={label} />;
  return <span className={cx(styles.dot, DOT[tone])} aria-hidden="true" />;
}

const BADGE: Record<HostTone, string | undefined> = {
  ok: styles.badgeOk,
  warn: styles.badgeWarn,
  bad: styles.badgeBad,
  mut: styles.badgeMut,
};

export function Badge({
  tone,
  children,
  dot,
  className,
}: {
  tone: HostTone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={cx(styles.badge, BADGE[tone], className)}>
      {dot ? <Dot tone={tone} /> : null}
      {children}
    </span>
  );
}

/** A state: its dot and words; `compact` keeps only the dot in a narrow card, the words for screen readers (AP-1754). */
export function StateCell({ tone, text, compact }: { tone: HostTone; text: string; compact?: boolean }) {
  return (
    <span className={styles.state} title={compact ? text : undefined}>
      <Dot tone={tone} />
      {compact ? <span className={styles.narrowSr}>{text}</span> : text}
    </span>
  );
}

export function Tags({ tags }: { tags: readonly string[] }) {
  return (
    <>
      {tags.map((t) => (
        <span key={t} className={styles.gtag}>
          {t}
        </span>
      ))}
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

export function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className={styles.empty} role="alert">
      <span className={styles.error}>{hostErrorInfo(error).message}</span>
      {onRetry ? (
        <>
          {' '}
          <button type="button" className={styles.cardLink} onClick={onRetry}>
            Try again
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Skeleton({ height }: { height: number }) {
  return <div className={styles.skeleton} style={{ height }} aria-hidden="true" />;
}

/** A yes-or-no before a change that stops or removes something. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirm,
  serious,
  busy,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirm: string;
  serious?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <ModalTitle className={styles.dialogTitle}>{title}</ModalTitle>
      {body ? <div className={styles.dialogBody}>{body}</div> : null}
      {children}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className={serious ? styles.seriousBtn : undefined}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {confirm}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Runs a change and says how it went: the done words as a toast, an approval or a missing key as a toast too, a
 * refusal returned (for a dialog to show) or toasted.
 */
export function useChangeRunner() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(
      send: () => Promise<CommitResult<T>>,
      done: string | ((data: T) => string | null) | null,
      opts: { inline?: boolean } = {},
    ): Promise<{ ok: true; data: T } | { ok: false; message: string; error?: unknown }> => {
      setBusy(true);
      try {
        const result = await send();
        if (result.status !== 'ok') {
          const message = commitOutcomeText(result) ?? '';
          toast.show(message);
          return { ok: false, message };
        }
        const text = typeof done === 'function' ? done(result.data) : done;
        if (text) toast.show(text);
        return { ok: true, data: result.data };
      } catch (error) {
        const message = hostErrorInfo(error).message;
        if (!opts.inline) toast.show(message);
        return { ok: false, message, error };
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
