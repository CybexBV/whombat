/**
 * An AI gateway connection's own parts (Whombat ai-gateway.md AIG-01, AIG-05, AIG-06, AIG-11; app AP-1117): on its page,
 * instead of the agent's level, handle and tools — which tools go through it (a block in CONNECTION, like
 * a report tracker's “Used by automations”), the pool's line (“Updated 1 min ago” / “Fusebox isn’t answering”), and CLAUDE CODE
 * AND CODEX: a switch per tool with the contracts' label and hint. Switching one on for Fusebox asks first with the terms (AIG-06). Saved at
 * once (`burrows.setAiGateway`); the answer's burrow goes into the bootstrap. Only on a runtime with `ai.gateway`. Not in
 * the mocks: Settings' rows with a title, the hint and the switch on the right (AgentsNetworkSection), the take-over
 * dialog's language (ConfirmDialog).
 */
import {
  ApiError,
  aiGatewayOf,
  GATEWAY_TEXT,
  gatewayConfirm,
  gatewayPoolLine,
  gatewaySavedText,
  gatewaySwitches,
  gatewayUsedBy,
} from '@whombat/client';
import { useBootstrap, useSetAiGateway } from '@whombat/client/react';
import {
  type BurrowAiGateway,
  type CatalogEntry,
  type ConnectionView,
  type GatewayPool,
  type GatewayProvider,
  gatewayKindOf,
} from '@whombat/core/domain';
import { useId, useState } from 'react';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import styles from '../settings/SettingsScreen.module.css';
import { useUsageList } from '../usage/useUsage';
import c from './Connectors.module.css';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Ours (AP-1117): the dialog's kicker and what a failed save says. */
export const GATEWAY_PAGE_TEXT = {
  kicker: 'AI GATEWAY',
  failed: 'That didn’t save. Try again in a moment.',
} as const;

/** This connection's part of the burrow's gateway: its switches when it is the burrow's gateway, else both off. */
export function useGatewayOf(burrow: string, conn: Pick<ConnectionView, 'id'>): BurrowAiGateway | null {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const gateway = aiGatewayOf(bootstrap?.burrow);
  return gateway && gateway.connectionId === conn.id ? gateway : null;
}

/** The pool `usage.list` reports for this connection (AIG-11). */
export function useGatewayPool(burrow: string, connectionId: string): GatewayPool | null {
  const query = useUsageList({ params: { burrow } }, { retry: false });
  const pool = query.data?.gateway ?? null;
  return pool && pool.connectionId === connectionId ? pool : null;
}

/** The pool's line under CONNECTION's state: “Updated 1 min ago”, or “Fusebox isn’t answering” in the warning colour. */
export function GatewayPoolLine({ pool }: { pool: GatewayPool }) {
  const line = gatewayPoolLine(pool, new Date(), LOCAL_TZ);
  return (
    <span className={c.meta} data-tone={line.tone === 'warn' ? 'warn' : undefined} data-gateway-pool="">
      {line.text}
    </span>
  );
}

/** CONNECTION's block instead of the agent's lines (AIG-01): which tools go through it now. */
export function GatewayUsedByBlock({ gateway }: { gateway: BurrowAiGateway | null }) {
  const used = gatewayUsedBy(gateway);
  return (
    <div className={c.block} data-block="used-by-gateway">
      <span className={c.main}>
        <span className={c.name}>{used.title}</span>
        <span className={c.meta}>{used.text}</span>
      </span>
    </div>
  );
}

/** CLAUDE CODE AND CODEX: a switch per tool; Fusebox asks before one goes on (AIG-06). */
export function GatewaySwitchesSection({
  burrow,
  entry,
  conn,
}: {
  burrow: string;
  entry: CatalogEntry;
  conn: ConnectionView;
}) {
  const ids = useId();
  const toast = useToast();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const gateway = useGatewayOf(burrow, conn);
  const set = useSetAiGateway(burrow);
  const [asking, setAsking] = useState<GatewayProvider | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!bootstrap) return null;
  const name = conn.label;
  const kind = gateway?.kind ?? gatewayKindOf(entry) ?? 'ai_gateway';
  const confirm = asking ? gatewayConfirm(kind, asking, name, true) : null;

  const save = async (provider: GatewayProvider, on: boolean): Promise<boolean> => {
    setProblem(null);
    try {
      const result = await set.mutateAsync({
        params: { burrow },
        body: provider === 'claude' ? { claude: on } : { codex: on },
      });
      if (result.status === 'ok') {
        toast.show(gatewaySavedText(provider, name, on));
        return true;
      }
      setProblem(result.status === 'blocked' ? result.message : GATEWAY_PAGE_TEXT.failed);
    } catch (e) {
      setProblem(e instanceof ApiError && e.message ? e.message : GATEWAY_PAGE_TEXT.failed);
    }
    return false;
  };

  const change = (provider: GatewayProvider, on: boolean) => {
    if (gatewayConfirm(kind, provider, name, on)) return setAsking(provider);
    void save(provider, on);
  };

  const switches = gatewaySwitches(name);
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-gateway-switches="">
      <SectionLabel as="h2" id={`${ids}-label`}>
        {GATEWAY_TEXT.section}
      </SectionLabel>
      <div className={styles.card}>
        {switches.map((s, i) => (
          <div
            key={s.provider}
            className={cx(styles.row, i === switches.length - 1 && styles.lastRow)}
            data-gateway-switch={s.provider}
          >
            <span className={styles.rowMain}>
              <label className={styles.rowTitle} htmlFor={`${ids}-${s.provider}`}>
                {s.label}
              </label>
              <span className={styles.rowMeta} id={`${ids}-${s.provider}-hint`}>
                {s.hint}
              </span>
            </span>
            <Toggle
              id={`${ids}-${s.provider}`}
              checked={gateway?.[s.provider] ?? false}
              disabled={set.isPending}
              aria-describedby={`${ids}-${s.provider}-hint`}
              onCheckedChange={(next) => change(s.provider, next)}
            />
          </div>
        ))}
      </div>
      {problem && !asking ? (
        <p className={c.error} role="alert">
          {problem}
        </p>
      ) : null}
      {confirm && asking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setAsking(null);
              setProblem(null);
            }
          }}
          kicker={GATEWAY_PAGE_TEXT.kicker}
          title={confirm.title}
          confirmLabel={confirm.confirm}
          busy={set.isPending}
          error={problem}
          onConfirm={() => {
            void save(asking, true).then((ok) => {
              if (ok) setAsking(null);
            });
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
