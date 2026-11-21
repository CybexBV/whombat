/**
 * Where files come from on the phone (AP-16, AP-27): a Whombat's, streamed through its session into scoped cache files.
 * Shared by the conversation (attachments) and people's photos (CT-265, docs/decisions/person-avatars.md).
 */
import type { ApplianceSession } from '@whombat/client/session';
import { useMemo } from 'react';
import { useManaged } from '../managed/context';

/** Through the Whombat's session, cached per scope (AP-17). */
export interface FileAccess {
  kind: 'session';
  session: ApplianceSession;
  scope: string;
}

/** This Whombat's file access; null in the demo world, which has no files to fetch. */
export function useFileAccess(): FileAccess | null {
  const managed = useManaged();
  const session = managed?.session;
  const scope = managed?.cacheScope;
  return useMemo<FileAccess | null>(
    () => (session && scope ? { kind: 'session', session, scope } : null),
    [session, scope],
  );
}
