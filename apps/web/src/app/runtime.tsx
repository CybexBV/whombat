/**
 * A load error in the app's words (AP-266). A box and this app speak one major version and every Whombat has every
 * feature (HE-52; hermes-engine-app.md AP-5320): no screen asks what the runtime can do.
 */
import { NeedsNewerAppError, SCREEN_NEEDS_NEWER_APP } from '@whombat/client';
import { ErrorNote } from '../components/ListState';

/**
 * A load error, or — when a security view's strictly decoded answer didn't match (AP-266) — “This needs a newer version
 * of the app. Reload to get the newest version.” with Reload: nothing shown half, nothing shown as something else.
 */
export function LoadErrorNote({
  error,
  message,
  onRetry,
  className,
}: {
  error: unknown;
  message: string;
  onRetry?: (() => void) | undefined;
  className?: string;
}) {
  if (error instanceof NeedsNewerAppError)
    return (
      <ErrorNote
        message={SCREEN_NEEDS_NEWER_APP}
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
        {...(className ? { className } : {})}
      />
    );
  return <ErrorNote message={message} onRetry={onRetry} {...(className ? { className } : {})} />;
}
