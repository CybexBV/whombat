import { useBlocker } from '@tanstack/react-router';
import { type AgentGroupPart, agentGroupParts, hasLooksAhead, SETTINGS_GROUP_TEXT } from '@whombat/client';
import { useAgent, useBootstrap, useSessionProtocol, useTheAgent } from '@whombat/client/react';
import type { AgentProfile } from '@whombat/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { Button } from '../../../components/Button';
import { SkeletonRows } from '../../../components/ListState';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { YourAi } from '../../ai/YourAi';
import { MemorySection } from '../../memory/MemorySection';
import { NotesTab } from '../../memory/NotesTab';
import { usePartInView } from '../../settings/usePartInView';
import { CredentialSection } from '../CredentialSection';
import styles from './AgentTab.module.css';
import { CouncilTab } from './CouncilTab';
import { LooksAheadPart } from './LooksAheadPart';
import { PermissionsTab } from './PermissionsTab';
import { ProfileTab } from './ProfileTab';

export interface AgentTabProps {
  burrow: string;
  /** `&part=` (absent: Name and face). */
  part?: AgentGroupPart;
  /** What it may do: the key row to show (`&key=`, a skill's “Turn on …” link). */
  agentKey?: string | undefined;
  /** Opens another part (replaces `&part=`). */
  onPartChange: (part: AgentGroupPart) => void;
}

/** What every part with the agent's profile gets. `onDirtyChange` tells the page there are unsaved changes. */
export interface SettingsTabProps {
  burrow: string;
  profile: AgentProfile;
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * Settings → the assistant by its name (`?tab=agent`; settings-groups.md; one-agent.md OA-09): its
 * **Name and face**, the **AI sign-in** it runs on (one place: what it runs on and your sign-ins), **Memory** (what it
 * remembers about you and the notes it reads in every chat, in one place), **What it may do** (every permission on
 * one page, with its keys and the commands always allowed), **Looks ahead** (what it checks on the person's calendar,
 * on a Whombat that has it) and the **Council** (who sits on the councils it leads). The
 * model, what it runs, its skills and spend are Settings → Advanced's. The open part is at `&part=`; leaving a part with
 * unsaved changes asks first.
 */
export function AgentTab({ burrow, part, agentKey, onPartChange }: AgentTabProps) {
  const { words } = useTheAgent(burrow);
  const labels = SETTINGS_GROUP_TEXT.agent(words.name);
  // Looks ahead only on a Whombat that has it; its address on an older one opens Name and face.
  const parts = agentGroupParts({ looksAhead: hasLooksAhead(useSessionProtocol()) });
  const current: AgentGroupPart = part && parts.includes(part) ? part : 'profile';
  usePartInView(styles.parts ?? '', current);
  return (
    <>
      <SegmentedControl
        variant="soft"
        label={SETTINGS_GROUP_TEXT.partsLabel(words.Name)}
        className={styles.parts}
        value={current}
        onChange={(next) => onPartChange(next)}
        options={parts.map((p) => ({ value: p, label: labels[p] }))}
      />
      <AgentProfilePart burrow={burrow} part={current} label={labels[current]}>
        {(props) => <PartPanel part={current} agentKey={agentKey} {...props} />}
      </AgentProfilePart>
    </>
  );
}

/**
 * A part that works on the agent's profile (here and in Advanced): it waits for the profile, holds the part's body, and
 * asks before leaving it with unsaved changes (the save bar's “Leave without saving?”).
 */
export function AgentProfilePart({
  burrow,
  part,
  label,
  children,
}: {
  burrow: string;
  /** The part's key: another part resets the unsaved state. */
  part: string;
  label: string;
  children: (props: SettingsTabProps) => ReactNode;
}) {
  const { words } = useTheAgent(burrow);
  const { data: profile, error, refetch } = useAgent({ params: { burrow } }, { retry: false });
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const [dirty, setDirty] = useState(false);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!dirtyRef.current) return false;
      const was = current.search as { tab?: string; part?: string };
      const goes = next.search as { tab?: string; part?: string };
      return current.pathname !== next.pathname || was.tab !== goes.tab || was.part !== goes.part;
    },
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });
  // A part that goes away (switched, left) has nothing unsaved any more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when another part opens
  useEffect(() => setDirty(false), [part]);

  if (!profile || !bootstrap) {
    return error ? (
      <LoadErrorNote
        error={error}
        message={`Couldn’t load ${words.name}’s settings. Try again in a moment.`}
        onRetry={() => void refetch()}
      />
    ) : (
      <SkeletonRows count={4} lines={1} />
    );
  }

  return (
    <>
      <section className={styles.partBody} aria-label={label} data-agent-part={part}>
        {children({ burrow, profile, onDirtyChange: setDirty })}
      </section>
      <Modal
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <ModalTitle className={styles.confirmTitle}>Leave without saving?</ModalTitle>
        <p className={styles.confirmText}>Your changes to {label.toLowerCase()} aren’t saved yet.</p>
        <div className={styles.confirmActions}>
          <Button variant="secondary" size="xl" onClick={() => blocker.reset?.()}>
            Stay
          </Button>
          <Button
            variant="primary"
            size="xl"
            onClick={() => {
              setDirty(false);
              dirtyRef.current = false;
              blocker.proceed?.();
            }}
          >
            Discard changes
          </Button>
        </div>
      </Modal>
    </>
  );
}

function PartPanel({
  part,
  agentKey,
  ...props
}: SettingsTabProps & { part: AgentGroupPart; agentKey?: string | undefined }): ReactNode {
  switch (part) {
    case 'ai':
      return <AiSignInPart {...props} />;
    case 'memory':
      return (
        <>
          {/* What it remembers about you, then the notes it reads in every chat: one place for what it knows. */}
          <MemorySection burrow={props.burrow} />
          <NotesTab {...props} />
        </>
      );
    case 'may':
      return <PermissionsTab {...props} showKey={agentKey} />;
    case 'ahead':
      return <LooksAheadPart burrow={props.burrow} />;
    case 'council':
      return <CouncilTab {...props} />;
    default:
      return <ProfileTab {...props} />;
  }
}

/**
 * AI sign-in: the sign-in the assistant runs on, then your Claude and ChatGPT sign-ins with how much is left. Which
 * model and how hard it thinks, the AI programs on this Whombat and a model on your network are Advanced's.
 */
function AiSignInPart({ burrow, profile }: SettingsTabProps) {
  const provider = profile.agent.runtime.provider;
  return (
    <>
      {/* A model on the network needs no one's sign-in (AP-5041). */}
      {provider !== 'local' ? <CredentialSection burrow={burrow} provider={provider} /> : null}
      <YourAi burrow={burrow} only="signins" />
    </>
  );
}
