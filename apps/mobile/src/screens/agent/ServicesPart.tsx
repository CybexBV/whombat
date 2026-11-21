/**
 * Advanced → Running (AP-5760; was Settings → Agent → Running): what the agent runs on your Whombat, with Stop; read
 * again while one is starting.
 */
import { useAgentServices } from '@whombat/client/react';
import { SERVICES_NOT_HERE } from '@whombat/core';
import { useBurrow } from '../../data/BurrowProvider';
import { SERVICES_TEXT } from '../../data/services';
import { CardLine } from '../../ui/facts';
import { ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { ServicesSection } from '../ServicesSection';
import { type PartProps, PartScroll } from './parts';

export function ServicesPart({ profile }: PartProps) {
  const { slug } = useBurrow();
  const query = useAgentServices(
    { params: { burrow: slug } },
    // Starting takes seconds: read again until none is, as the web does (`services.changed` also refetches).
    {
      retry: false,
      refetchInterval: (q) => (q.state.data?.services.some((s) => s.state === 'starting') ? 2000 : false),
    },
  );
  return (
    <PartScroll refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.data?.available === false ? (
        <Section title={SERVICES_TEXT.title}>
          <CardLine text={query.data.reason ?? SERVICES_NOT_HERE} />
        </Section>
      ) : query.data ? (
        <ServicesSection agent={profile.agent} services={query.data.services} />
      ) : query.error ? (
        <ErrorState text={SERVICES_TEXT.loadFailed} onRetry={() => void query.refetch()} />
      ) : (
        <SkeletonRows count={2} lines={2} />
      )}
    </PartScroll>
  );
}
