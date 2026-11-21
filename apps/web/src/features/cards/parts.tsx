import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf } from '@whombat/client';
import type { NameInfo, Principal, Tone } from '@whombat/core';
import { shortNameOf } from '@whombat/core';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { cx } from '../../components/cx';
import { PersonAvatar } from '../messaging/PersonAvatar';
import styles from './Card.module.css';

/** Finds a person or agent by id (the cached bootstrap's `principals`). */
export type PrincipalLookup = (id: string) => Principal | undefined;

export function principalLookup(principals: readonly Principal[] | undefined): PrincipalLookup {
  const byId = new Map((principals ?? []).map((p) => [p.id, p]));
  return (id) => byId.get(id);
}

/** Name lookup in the shape `approvalView()` wants. */
export function nameLookup(lookup: PrincipalLookup): (id: string) => NameInfo | undefined {
  return (id) => {
    const p = lookup(id);
    return p ? { name: p.name, shortName: shortNameOf(p) } : undefined;
  };
}

/**
 * Called for in-app links instead of a full page load (plain left clicks only; modified clicks and
 * middle clicks keep the browser's behaviour, so "open in a new tab" works).
 */
export type NavigateHandler = (href: string) => void;

export const TONE_CLASS: Record<Tone, string | undefined> = {
  ok: styles.toneOk,
  warn: styles.toneWarn,
  bad: styles.toneBad,
  neutral: styles.toneNeutral,
};

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export interface CardLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  onNavigate?: NavigateHandler;
  children: ReactNode;
}

/** An `<a>` that routes in-app hrefs through `onNavigate` and opens external ones in a new tab. */
export function CardLink({ href, onNavigate, onClick, children, ...rest }: CardLinkProps) {
  const external = isExternal(href);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (external || !onNavigate || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}

export interface CardActionProps extends CardLinkProps {
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'sm';
}

/** A card CTA that navigates ("Watch run", "Open plan canvas"): a link styled as the mock's button. */
export function CardAction({ variant = 'secondary', size = 'md', className, ...rest }: CardActionProps) {
  return (
    <CardLink
      className={cx(styles.action, size === 'sm' && styles.actionSm, styles[variant], className)}
      {...rest}
    />
  );
}

/** Avatar for a person or agent (head crop below 40px). Decorative: the name sits next to it. */
export function PrincipalAvatar({ principal, size }: { principal: Principal | undefined; size: number }) {
  if (principal?.kind === 'agent') return <WhombatAvatar face={agentFaceOf(principal)} size={size} />;
  if (principal?.kind === 'person')
    return (
      <PersonAvatar
        avatarUrl={principal.avatarUrl}
        initials={principal.initials}
        tone={principal.tone}
        size={size}
      />
    );
  return <HumanAvatar initials="?" size={size} />;
}

/** `+214 −12 · 6 files` with the mock's colours (additions ok, deletions bad). */
export function DiffStatText({
  add,
  del,
  suffix,
}: {
  add: string;
  del: string;
  /** Muted tail, e.g. `· 6 files`. */
  suffix?: ReactNode;
}) {
  return (
    <>
      <span className={styles.add}>{add}</span> <span className={styles.del}>{del}</span>
      {suffix !== undefined && <> {suffix}</>}
    </>
  );
}
