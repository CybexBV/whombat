/**
 * “Look around without a Whombat” (docs/app/decisions/look-around.md): the burrow app on the mock world, the one fixture
 * mode and the screenshots show, inside the hosted app. Its own chunks load only when someone opens it; the address bar
 * stays where it was (a memory history), so a reload is the sign-in page again. Nothing reaches control or a Whombat:
 * the mock world answers in the page. Every screen says it is a demo (`DemoNotice`), and Leave the demo comes back.
 */
import { createMemoryHistory } from '@tanstack/react-router';
import { COPY } from '@whombat/client/managed';
import { useEffect, useState } from 'react';
import { App } from '../app/App';
import { AuthLayout } from '../app/auth/AuthLayout';
import { type AppServices, createAppServices } from '../app/services';
import { Button } from '../components/Button';
import styles from './managed.module.css';
import { ErrorLine } from './screens';

export function DemoWorld({ onLeave }: { onLeave: () => void }) {
  const [services, setServices] = useState<AppServices | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [history] = useState(() => createMemoryHistory({ initialEntries: ['/'] }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: Try again (a new attempt) loads the world again.
  useEffect(() => {
    let live = true;
    setFailed(false);
    import('../app/fixtureWorld').then(
      ({ fixtureWorld }) =>
        live &&
        setServices(createAppServices({ fixtures: true, world: fixtureWorld, demo: { leave: onLeave } })),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  if (services) return <App services={services} history={history} />;
  return (
    <AuthLayout kicker={COPY.signIn.kicker} title={COPY.lookAround.open} tip={COPY.signIn.tip}>
      {failed ? (
        <>
          <ErrorLine text={COPY.lookAround.failed} />
          <div className={styles.actions}>
            <Button variant="primary" size="lg" onClick={() => setAttempt((n) => n + 1)}>
              {COPY.lookAround.retry}
            </Button>
            <Button variant="link" onClick={onLeave}>
              {COPY.lookAround.leave}
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.status} role="status">
          {COPY.lookAround.loading}
        </p>
      )}
    </AuthLayout>
  );
}
