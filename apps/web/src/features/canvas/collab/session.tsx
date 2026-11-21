/**
 * Opening a canvas's collaboration session from React: the session's collaboration stream, or the fixture hub in
 * fixture mode.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { fixtureMode } from '../../../app/fixtureMode';
import { useAppServices } from '../../../app/providers';
import { createSessionCollab } from './sessionCollab';
import type { CanvasCollabFactory, CanvasCollabSession, CanvasCollabTarget, CollabSnapshot } from './types';

function useCollabFactory(): CanvasCollabFactory {
  const { fixtures, fixtureWorld, session } = useAppServices();
  // The world the services were made with (the hosted app's demo hands its own in), else fixture mode's.
  const world = fixtureWorld ?? (fixtures ? fixtureMode : null);
  return useMemo<CanvasCollabFactory>(
    () => world?.canvasSession ?? ((target) => createSessionCollab(target, session)),
    [world, session],
  );
}

const NO_SNAPSHOT: CollabSnapshot = { status: 'connecting', synced: false, scope: null };

/**
 * The collaboration session of a canvas while mounted (null until the canvas is known). A new target opens a
 * new session; the old one is destroyed.
 */
export function useCanvasCollab(target: CanvasCollabTarget | null): {
  session: CanvasCollabSession | null;
  snapshot: CollabSnapshot;
} {
  const factory = useCollabFactory();
  const [session, setSession] = useState<CanvasCollabSession | null>(null);
  const key = target ? `${target.burrow}|${target.slug}|${target.canvasId}|${target.documentName}` : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the session follows the target's identity (key).
  useEffect(() => {
    if (!target) {
      setSession(null);
      return;
    }
    const s = factory(target);
    setSession(s);
    return () => {
      setSession((current) => (current === s ? null : current));
      s.destroy();
    };
  }, [key, factory]);

  const snapshot = useSyncExternalStore(
    (cb) => (session ? session.subscribe(cb) : () => {}),
    () => session?.snapshot() ?? NO_SNAPSHOT,
    () => NO_SNAPSHOT,
  );
  return { session, snapshot };
}
