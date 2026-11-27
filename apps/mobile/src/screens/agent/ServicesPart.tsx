/**
 * Advanced → Running (AP-5760; was Settings → Agent → Running): what the agent runs on your Whombat, with Stop; read
 * again while one is starting.
 */
import { useAgentServices } from '@whombat/client/react';

import { useBurrow } from '../../data/BurrowProvider';
import { servicesText } from '../../data/services';
import { mobileTranslator, useI18n } from '../../i18n';
import { CardLine } from '../../ui/facts';
import { ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { ServicesSection } from '../ServicesSection';
import { type PartProps, PartScroll } from './parts';

export function ServicesPart({ profile }: PartProps) {
  const { rawLocale } = useI18n();
  const { slug } = useBurrow();
  const copy = servicesText(rawLocale);
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
        <Section title={copy.title}>
          <CardLine
            text={query.data.reason ?? mobileTranslator(rawLocale).t('screens2.agent.servicesNotHere')}
          />
        </Section>
      ) : query.data ? (
        <ServicesSection agent={profile.agent} services={query.data.services} />
      ) : query.error ? (
        <ErrorState text={copy.loadFailed} onRetry={() => void query.refetch()} />
      ) : (
        <SkeletonRows count={2} lines={2} />
      )}
    </PartScroll>
  );
}
