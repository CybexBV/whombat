import type { ConnectorService, GuideConnectBlock } from '@whombat/core/domain';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ServicePicker } from '../connectors/ServicePicker';
import { useConnectGoogle } from '../connectors/useConnectGoogle';
import guide from './GuideCard.module.css';

export interface GuideConnectProps {
  burrow: string;
  block: GuideConnectBlock;
  /** Where the consent URL is opened (tests); a full-page navigation by default. */
  navigate?: (url: string) => void;
}

/**
 * “Connect Google” in a guide (AG-05, AG-08): the services, ticked as the server suggests (CN-04: all of them, the
 * topic's first), and the button. The card's `returnTo` goes to `connections.startGoogle` unchanged, so Google comes
 * back to this DM, where the server posts the result.
 */
export function GuideConnect({ burrow, block, navigate }: GuideConnectProps) {
  const [services, setServices] = useState<ConnectorService[]>(() => [...block.services]);
  const { connect, busy, problem } = useConnectGoogle(burrow, navigate, { returnTo: block.returnTo });
  return (
    <div className={guide.connect}>
      <div className={guide.connectServices}>
        <ServicePicker value={services} onChange={setServices} disabled={busy} />
      </div>
      <div className={guide.actions}>
        <Button
          variant="primary"
          size="lg"
          disabled={busy || services.length === 0}
          onClick={() => void connect(services)}
        >
          {block.reconnect ? 'Reconnect Google' : 'Connect Google'}
        </Button>
      </div>
      {problem ? (
        <p className={guide.problem} role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
