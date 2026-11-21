/**
 * Which remote help the phone talks to (app docs/decisions/remote-help.md AP-4470): the Whombat's `remoteHelp.*` through
 * its session, with this phone's passkeys (`PASSKEYS`, Credential Manager) and its key (the
 * session's PeerId, which the challenge names); or the demo world's (`fixtures/remoteHelp.ts`, its own authenticator).
 */
import { useQueryClient } from '@tanstack/react-query';
import { type PasskeyPlatform, type RemoteHelpApi, remoteHelpApi } from '@whombat/client/managed';
import { REMOTE_HELP_QUERY_KEY } from '@whombat/client/react';
import { useEffect, useMemo } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import { demoRemoteHelp } from '../fixtures/remoteHelp';
import { useManaged } from './context';
import { PASSKEYS } from './passkeyEnv';

/** `remoteHelp.` — the ops' part of the hook's query keys (`[root, 'remoteHelp.get', …]`). */
const REMOTE_HELP_OPS = String(REMOTE_HELP_QUERY_KEY[1]).replace(/get$/, '');

export interface RemoteHelpHere {
  /** There is a Whombat here that could have remote help (a managed one, or the demo's): the section shows. */
  shown: boolean;
  api: RemoteHelpApi | null;
  /** This phone's passkeys; null where it can't use them. */
  platform: PasskeyPlatform | null;
  /** This phone's key, which the passkey challenge names. */
  endpoint: string;
}

/** Remote help here: the Whombat's, or the demo's. */
export function useRemoteHelpHere(): RemoteHelpHere {
  const managed = useManaged();
  const { mode, me } = useBurrowBase();
  const session = managed?.session ?? null;
  const demo = !session && mode === 'fixtures' ? demoRemoteHelp({ me }) : null;
  const api = useMemo(() => (session ? remoteHelpApi(session) : (demo?.api ?? null)), [session, demo]);
  // Support's side of the demo (Claude connecting) as the next poll would bring it, at once; a demo started over in
  // another state is read again whole (the state, the visits, whether you have a passkey).
  const qc = useQueryClient();
  useEffect(
    () =>
      demo?.onChange(
        () =>
          void qc.invalidateQueries({
            predicate: (q) => String(q.queryKey[1]).startsWith(REMOTE_HELP_OPS),
          }),
      ),
    [demo, qc],
  );
  return {
    shown: session !== null || demo !== null,
    api,
    platform: session ? PASSKEYS : (demo?.platform ?? null),
    endpoint: managed?.devicePeerId ?? demo?.endpoint ?? '',
  };
}
