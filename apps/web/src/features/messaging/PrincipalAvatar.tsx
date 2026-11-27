import type { FaceState } from '@whombat/avatars/motion';
import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf, automationLabel, isAutomationPrincipal } from '@whombat/client';
import type { Principal } from '@whombat/core';
import { Workflow } from 'lucide-react';
import type { CSSProperties } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { LiveAgentFace } from '../agent/LiveAgentFace';
import { PersonAvatar } from './PersonAvatar';
import styles from './PrincipalAvatar.module.css';

/**
 * An automation where an avatar goes (automation-recipes.md AP-997): the sidebar's Automations mark on a quiet disc,
 * never an agent's wombat. `label` announces it (“Automation “Assess and fix …””); without it it is decorative.
 */
export function AutomationAvatar({
  size,
  label,
  className,
  style,
}: {
  size: number;
  label?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const props = {
    className: cx(styles.automation, className),
    style: { width: size, height: size, ...style },
    'data-automation-avatar': '',
  };
  const mark = <Icon icon={Workflow} size={Math.round(size * 0.5)} />;
  return label ? (
    <span role="img" aria-label={label} {...props}>
      {mark}
    </span>
  ) : (
    <span aria-hidden="true" {...props}>
      {mark}
    </span>
  );
}

export interface PrincipalAvatarProps {
  principal: Principal | undefined;
  size: number;
  /** Agents: `head` crop (default below 40px) or `bust` (default from 40px). */
  crop?: 'head' | 'bust';
  /** Font size of a person's initials when the mock deviates from the avatar package's scale. */
  initialsSize?: number;
  /** Announce the avatar ("Banjo, developer"); leave off when the name is shown next to it. */
  labelled?: boolean;
  /** An agent's live face, showing what it does now (thinking); without it, the still face. */
  state?: FaceState | null;
  className?: string;
  style?: CSSProperties;
}

/** A person's photo or initials disc, an agent's wombat, or an automation's mark, at the sizes the mock uses. */
export function PrincipalAvatar({
  principal,
  size,
  crop,
  initialsSize,
  labelled = false,
  state = null,
  className,
  style,
}: PrincipalAvatarProps) {
  if (!principal) {
    return <HumanAvatar initials="?" size={size} className={className} style={style} />;
  }
  if (isAutomationPrincipal(principal))
    return (
      <AutomationAvatar
        size={size}
        label={labelled ? automationLabel(principal.name) : undefined}
        className={className}
        style={style}
      />
    );
  if (principal.kind === 'agent') {
    if (state)
      return (
        <LiveAgentFace
          face={agentFaceOf(principal)}
          size={size}
          crop={crop}
          state={state}
          label={labelled ? principal.name : undefined}
          decorative={!labelled}
          className={className}
          style={style}
        />
      );
    return (
      <WhombatAvatar
        face={agentFaceOf(principal)}
        size={size}
        crop={crop}
        label={labelled ? principal.name : undefined}
        className={className}
        style={style}
      />
    );
  }
  if (principal.kind === 'system')
    return (
      <HumanAvatar
        initials={principal.name}
        size={size}
        label={labelled ? principal.name : undefined}
        className={className}
        style={style}
      />
    );
  return (
    <PersonAvatar
      avatarUrl={principal.avatarUrl}
      initials={principal.initials}
      tone={principal.tone}
      size={size}
      label={labelled ? principal.name : undefined}
      className={className}
      style={initialsSize ? { fontSize: initialsSize, ...style } : style}
    />
  );
}
