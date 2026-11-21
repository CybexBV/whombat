import { CHAT_WORDS, SETTLE_WORDS } from '@whombat/client';
import { type ComponentType, lazy } from 'react';
import { SidePane } from '../../components/SidePane';
import { useNavigateHref, useSearchUpdate } from '../routing/navigation';
import type { ModalState, PaneState } from './shellState';
import type { ThreadOrigin } from './threadOrigin';

const paneChunks: (() => Promise<unknown>)[] = [];

/**
 * Loads every pane's and modal's chunk. Tests that render the whole app start with them loaded, so the first test to
 * open a pane doesn't spend its wait on the bundler.
 */
export async function loadPaneChunks(): Promise<void> {
  await Promise.all(paneChunks.map((load) => load()));
}

/** A pane or modal from its feature's chunk, loaded when first shown (WE-01; the shell wraps the hosts in Suspense). */
function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K): M[K] {
  paneChunks.push(load);
  // biome-ignore lint/suspicious/noExplicitAny: React.lazy's own constraint; the result keeps the export's type.
  return lazy(async () => ({ default: (await load())[name] as ComponentType<any> })) as M[K];
}

const ThreadPane = lazyNamed(() => import('../../features/messaging/ThreadPane'), 'ThreadPane');
const SettledPane = lazyNamed(() => import('../../features/chats/SettledPane'), 'SettledPane');
const SubjectChip = lazyNamed(() => import('../../features/chats/SubjectChip'), 'SubjectChip');
const PinsPane = lazyNamed(() => import('../../features/messaging/PinsPane'), 'PinsPane');
const PlanPane = lazyNamed(() => import('../../features/plans/PlanPane'), 'PlanPane');
const PlansPane = lazyNamed(() => import('../../features/plans/PlansPane'), 'PlansPane');
const ApprovalModal = lazyNamed(() => import('../../features/approvals/ApprovalModal'), 'ApprovalModal');

/** Right pane host: the thread, settled, plan, plans or pins pane (400px). */
export function PaneHost({
  burrow,
  pane,
  origin = null,
  beside = false,
}: {
  burrow: string;
  pane: PaneState;
  /** Where a room's thread was opened from (its back link); null: its room. */
  origin?: ThreadOrigin | null;
  /**
   * A room's thread beside its list (a wide screen, chat-inbox-web.md): the list keeps the focus, as in a mail app,
   * so J and K go on moving through it.
   */
  beside?: boolean;
}) {
  const updateSearch = useSearchUpdate();
  const navigateHref = useNavigateHref();
  if (!pane) return null;
  if (pane.kind === 'thread') {
    const room = pane.room;
    const closeToRoom = () => updateSearch((s) => ({ ...s, thread: undefined, focus: undefined }));
    // A room's thread has one way out: back to where it was opened from, else its room.
    const back = room
      ? origin
        ? { label: origin.label, href: origin.href, onBack: () => navigateHref(origin.href) }
        : { label: CHAT_WORDS[room], href: `/${room}`, onBack: () => void closeToRoom() }
      : null;
    // Focus mode (ui-improvements.md AP-304) keeps the same tree, so the reply draft survives the switch; another
    // thread is a new pane (its own draft, chips and scroll; web-messages.md WX-04).
    return (
      <SidePane
        width={pane.focus ? 'full' : 'thread'}
        aria-label="Thread"
        data-focus={pane.focus || undefined}
        data-beside={beside || undefined}
        takeFocus={!beside}
      >
        <ThreadPane
          key={pane.threadId}
          burrow={burrow}
          threadId={pane.threadId}
          focus={pane.focus}
          onFocusChange={(focus) =>
            // A room's thread is always full width: its back link goes back to the room (AP-2415).
            pane.room && !focus
              ? updateSearch((s) => ({ ...s, thread: undefined, focus: undefined }))
              : updateSearch((s) => ({ ...s, focus: focus ? 1 : undefined }))
          }
          onClose={() => updateSearch((s) => ({ ...s, thread: undefined, focus: undefined }))}
          {...(room && back
            ? {
                chatRoom: room,
                back,
                renderSubject: (subject) => <SubjectChip burrow={burrow} subject={subject} />,
              }
            : {})}
        />
      </SidePane>
    );
  }
  if (pane.kind === 'settled') {
    // A room's settled threads (chat-settle.md): a row opens its thread in its room.
    return (
      <SidePane width="thread" aria-label={SETTLE_WORDS.settled}>
        <SettledPane
          burrow={burrow}
          room={pane.room}
          onOpen={(rootId) => updateSearch((s) => ({ ...s, settled: undefined, thread: rootId }))}
          onClose={() => updateSearch((s) => ({ ...s, settled: undefined }))}
        />
      </SidePane>
    );
  }
  if (pane.kind === 'plan') {
    return (
      <SidePane width="thread" aria-label="Plan">
        <PlanPane
          key={pane.planId}
          burrow={burrow}
          planId={pane.planId}
          stepId={pane.stepId}
          onClose={() => updateSearch((s) => ({ ...s, plan: undefined, step: undefined }))}
        />
      </SidePane>
    );
  }
  if (pane.kind === 'pins') {
    return (
      <SidePane width="thread" aria-label="Pinned messages">
        <PinsPane burrow={burrow} onClose={() => updateSearch((s) => ({ ...s, pins: undefined }))} />
      </SidePane>
    );
  }
  return (
    <SidePane width="thread" aria-label="Plans">
      <PlansPane burrow={burrow} onClose={() => updateSearch((s) => ({ ...s, plans: undefined }))} />
    </SidePane>
  );
}

/** Modal host: modals are driven by search params so they deep-link and survive reloads. */
export function ModalHost({ burrow, modal }: { burrow: string; modal: ModalState }) {
  const updateSearch = useSearchUpdate();
  return (
    <>
      {modal?.kind === 'approval' && (
        <ApprovalModal
          burrow={burrow}
          number={modal.number}
          open
          onOpenChange={(open) => {
            if (!open) updateSearch((s) => ({ ...s, approval: undefined }));
          }}
        />
      )}
    </>
  );
}
