/**
 * The managed Whombat's AI providers (AP-22), each state worded differently, in the settings sheet's AI group under
 * the provider cards (Whombat settings-simplify.md SS-03, SS-30: AI readiness is shown once, under AI; This Whombat no
 * longer lists it). `folded` puts them under one “AI on this Whombat” fold that opens by itself when one isn't ready
 * (less-is-more.md AP-1816). Read from `appliance.status` when the sheet opens; nothing while it loads, fails or has
 * none.
 */
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { AI_TEXT } from '../settings/ai';
import { MoreFold } from '../ui/fold';
import { useManagedOrThrow } from './context';
import { MANAGED_TEXT } from './copy';
import { Card, type Dot, Row } from './ui';

function dotOf(state: ApplianceStatus['providers'][number]['state']): Dot {
  if (state === 'ready') return 'ok';
  return state === 'outage' || state === 'quota_exhausted' || state === 'version_drift' ? 'warn' : 'bad';
}

export function AiProviders({ folded = false }: { folded?: boolean }) {
  const { session } = useManagedOrThrow();
  const [providers, setProviders] = useState<ApplianceStatus['providers'] | null>(null);
  useEffect(() => {
    let live = true;
    sessionOps.applianceStatus(session).then(
      (s) => live && setProviders(s.providers),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session]);
  if (!providers?.length) return null;
  const card = (
    <Card label={folded ? undefined : MANAGED_TEXT.providers}>
      {providers.map((p, i) => (
        <Row
          key={p.provider}
          first={i === 0}
          dot={dotOf(p.state)}
          title={`${MANAGED_TEXT.providerNames[p.provider] ?? p.provider} · ${MANAGED_TEXT.provider[p.state] ?? p.state}`}
          meta={p.explanation ?? null}
        />
      ))}
    </Card>
  );
  if (!folded) return card;
  return (
    <MoreFold label={AI_TEXT.whombatAi} open={providers.some((p) => p.state !== 'ready')} inset={6}>
      {card}
    </MoreFold>
  );
}
