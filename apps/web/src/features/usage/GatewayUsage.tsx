/**
 * The AI gateway's pool in Settings → AI → Usage (Whombat ai-gateway.md AIG-11, AIG-13; contracts 0.76.0, CT-332; app
 * AP-1120): a section under the connection's name, above YOUR SUBSCRIPTIONS. Its line says when Whombat last read it
 * (“Updated 1 min ago”) or that it isn't answering. Fusebox: a card per provider (Claude, then ChatGPT) saying whether
 * that tool's switch is on, with a block per account — its name (as the server gives it), plan and state (“Used up until Monday 09:00”, “Sign-in
 * expired”, “Off in Fusebox”) — and the same meters as your own subscriptions. The generic AI gateway reports no
 * accounts: one card says whether it answers. Not in the mocks: Usage's own cards, rows and meters.
 */
import {
  GATEWAY_TEXT,
  gatewayAccountGroups,
  gatewayAccountStatus,
  gatewayPoolLine,
  gatewayProviderLine,
} from '@whombat/client';
import {
  GATEWAY_PROVIDERS,
  type GatewayAccountUsage,
  type GatewayPool,
  type GatewayProvider,
  sortUsageWindows,
} from '@whombat/core/domain';
import { AI_GATEWAY_COPY } from '@whombat/core/text';
import { useId } from 'react';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import settings from '../settings/SettingsScreen.module.css';
import { formatPlan } from './model';
import styles from './Usage.module.css';
import { WindowMeter } from './WindowMeter';

export function GatewayUsage({ pool, now, timeZone }: { pool: GatewayPool; now: number; timeZone: string }) {
  const id = useId();
  const line = gatewayPoolLine(pool, now, timeZone);
  const groups = gatewayAccountGroups(pool);
  // A switched-on tool whose provider has no accounts still gets its card: it has nothing to run on.
  const shown = GATEWAY_PROVIDERS.filter((p) => groups.some((g) => g.provider === p) || pool[p]);
  return (
    <section className={settings.section} aria-labelledby={id} data-usage-gateway={pool.kind}>
      <SectionLabel as="h3" id={id}>
        {pool.name.toUpperCase()}
      </SectionLabel>
      <p className={styles.hint} data-tone={line.tone} data-gateway-line="">
        {line.text}
      </p>
      <div className={styles.cards}>
        {pool.kind === 'fusebox' ? (
          shown.map((provider) => (
            <ProviderCard
              key={provider}
              pool={pool}
              provider={provider}
              accounts={groups.find((g) => g.provider === provider)?.accounts ?? []}
              now={now}
              timeZone={timeZone}
            />
          ))
        ) : (
          <AnswersCard pool={pool} line={line} />
        )}
      </div>
    </section>
  );
}

/** Fusebox's accounts of one provider, under whether that tool goes through it. */
function ProviderCard({
  pool,
  provider,
  accounts,
  now,
  timeZone,
}: {
  pool: GatewayPool;
  provider: GatewayProvider;
  accounts: readonly GatewayAccountUsage[];
  now: number;
  timeZone: string;
}) {
  const id = useId();
  const name = AI_GATEWAY_COPY.groups[provider];
  return (
    <article className={settings.card} aria-labelledby={id} data-gateway-provider={provider}>
      <div className={settings.row}>
        <span className={settings.rowMain}>
          <span className={settings.rowTitle} id={id}>
            {name}
          </span>
          <span className={settings.rowMeta} data-gateway-switch={pool[provider] ? 'on' : 'off'}>
            {gatewayProviderLine(provider, pool)}
          </span>
        </span>
      </div>
      {accounts.length === 0 ? (
        <div className={`${settings.row} ${styles.solo}`}>
          <span className={styles.quiet}>{GATEWAY_TEXT.noAccounts(name, pool.name)}</span>
        </div>
      ) : (
        accounts.map((a) => (
          <Account key={a.key} account={a} pool={pool} provider={name} now={now} timeZone={timeZone} />
        ))
      )}
    </article>
  );
}

/** One account: its name, plan and state, then its meters. */
function Account({
  account: a,
  pool,
  provider,
  now,
  timeZone,
}: {
  account: GatewayAccountUsage;
  pool: GatewayPool;
  provider: string;
  now: number;
  timeZone: string;
}) {
  const status = gatewayAccountStatus(a, pool, now, timeZone);
  const plan = a.planName ?? formatPlan(a.plan);
  const windows = sortUsageWindows(a.windows);
  return (
    <div className={styles.account} data-gateway-account={a.key}>
      <div className={styles.accountHead}>
        <span className={a.label.includes('@') ? styles.accountEmail : styles.accountName}>{a.label}</span>
        <span className={styles.accountMeta}>
          {plan ? `${plan} plan` : null}
          {plan && status ? ' · ' : null}
          {status ? (
            <span className={styles.accountStatus} data-tone={status.tone}>
              {status.text}
            </span>
          ) : null}
        </span>
      </div>
      {windows.length > 0 ? (
        <div className={styles.windows}>
          {windows.map((w) => (
            <WindowMeter
              key={`${w.kind}-${w.label}`}
              provider={`${a.label}, ${provider}`}
              window={w}
              now={now}
              timeZone={timeZone}
            />
          ))}
        </div>
      ) : (
        <span className={`${styles.quiet} ${styles.accountQuiet}`}>{GATEWAY_TEXT.noLimits(pool.name)}</span>
      )}
    </div>
  );
}

/** The generic AI gateway reports no accounts: whether it answers, and which tools go through it. */
function AnswersCard({ pool, line }: { pool: GatewayPool; line: { text: string } }) {
  const id = useId();
  return (
    <article className={settings.card} aria-labelledby={id} data-gateway-answers={pool.reachable}>
      <div className={`${settings.row} ${styles.solo}`}>
        <StatusDot tone={pool.reachable ? 'ok' : 'warn'} size={8} label={null} />
        <span className={settings.rowMain}>
          <span className={settings.rowTitle} id={id}>
            {pool.reachable ? AI_GATEWAY_COPY.answering(pool.name) : line.text}
          </span>
          <span className={settings.rowMeta}>
            {GATEWAY_PROVIDERS.map((p) => gatewayProviderLine(p, pool)).join(' · ')}
          </span>
        </span>
      </div>
    </article>
  );
}
