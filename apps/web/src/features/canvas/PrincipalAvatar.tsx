import { WhombatAvatar } from '@whombat/avatars/react';
import { DEFAULT_AGENT_FACE } from '@whombat/core';
import { PersonAvatar } from '../messaging/PersonAvatar';
import type { PrincipalLite } from './principals';

/** The agent's avatar (its face, FA-06) or a person's photo or initials; an empty box while the principal is unknown. */
export function PrincipalAvatar({
  principal,
  size,
  label,
}: {
  principal: PrincipalLite | undefined;
  size: number;
  /** Accessible name (omit when the name is shown next to it). */
  label?: string;
}) {
  if (!principal) return <span style={{ width: size, height: size, flex: 'none' }} aria-hidden="true" />;
  if (principal.kind === 'agent') {
    return (
      <WhombatAvatar face={principal.face ?? DEFAULT_AGENT_FACE} size={size} {...(label ? { label } : {})} />
    );
  }
  return (
    <PersonAvatar
      avatarUrl={principal.avatarUrl}
      initials={principal.initials}
      tone={principal.tone}
      size={size}
      {...(label ? { label } : {})}
    />
  );
}
