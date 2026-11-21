/**
 * A machine's page when its machine can't be read (Whombat server-pages.md): not a red line alone, but what may have
 * happened in plain words, the way back to its server's machines, the assistant, and Try again.
 */
import { useTheAgent } from '@whombat/client/react';
import { Button } from '../../../components/Button';
import { Card } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';

export function GuestMissing({
  burrow,
  serverName,
  guestName,
  onRetry,
}: {
  burrow: string;
  serverName: string;
  /** Its name when the server's list still has it; else none. */
  guestName?: string | null;
  onRetry: () => void;
}) {
  const [, set] = useThingSearch();
  const { words } = useTheAgent(burrow);
  const what = guestName ? `“${guestName}”` : 'this machine';
  return (
    <Card>
      <div className={styles.missing} role="alert">
        <p>
          {serverName} doesn’t have {what} any more, or Whombat couldn’t reach it just now.
        </p>
        <div className={styles.missingActs}>
          <Button variant="primary" onClick={() => set({ guest: undefined, gtab: undefined, tab: 'guests' })}>
            Back to {serverName}’s machines
          </Button>
          <Button onClick={() => set({ ask: '1' }, { replace: true })}>{words.ask}</Button>
          <Button variant="link" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </Card>
  );
}
