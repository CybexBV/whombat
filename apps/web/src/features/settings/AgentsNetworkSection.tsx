import { ApiError } from '@whombat/client';
import { useBootstrap, useSetAgentsReachLan, useTheAgent, useVaultNetworks } from '@whombat/client/react';
import { agentsReachLanOn } from '@whombat/core';
import { useId } from 'react';
import { LOCAL_NETWORK_ANCHOR } from '../../app/routing/search';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { HomeNetwork } from '../vault/HomeNetwork';
import styles from './SettingsScreen.module.css';

/** Ours (AP-687): the section's label. */
export const AGENTS_NETWORK_TEXT = {
  label: 'LOCAL NETWORK',
  failed: 'That didn’t save. Try again in a moment.',
} as const;

/**
 * The switch's words (less-is-more.md AP-1806): core's, with its hint in one sentence (AP-1751); in the assistant shell
 * (`assistant`, its name) the assistant instead of “agents”.
 */
export function lanWords(agent: string): { label: string; hint: string; on: string; off: string } {
  return {
    label: `${agent} may reach your local network`,
    hint: `${agent} and the Vault can reach devices on your local network, like Home Assistant or a NAS; off, only the home networks you list.`,
    on: `${agent} can now reach your local network.`,
    off: `${agent} now reaches only the home networks you list.`,
  };
}

/**
 * Settings → This Whombat → **Dusty may reach your local network** (SS-06; Whombat resourceful-agents.md RA-41,
 * local-network.md LN-01; contracts 0.44 `burrows.setAgentsReachLan`, 0.56; AP-687, AP-829): whether the agent, its
 * commands and the Vault reach the devices on the local network (on unless the person switched it off; production
 * servers stay closed; off: the home network list only). The commands run on the Whombat itself now (one-person.md
 * AP-5696), so it shows wherever the bootstrap is there. Saved at once; signed in the Keys log. Not in the mocks: Settings' rows (a title, the hint, the switch on the right).
 * While it is off, the home network list follows: the only private networks and ports still open then. While it is on,
 * the list changes nothing (local-network.md LN-03), so it isn't shown.
 */
export function AgentsNetworkSection({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const { words } = useTheAgent(burrow);
  const set = useSetAgentsReachLan(burrow);
  if (!bootstrap) return null;
  // The agent by its name, one sentence of help (less-is-more.md AP-1751, AP-1806).
  const said = lanWords(words.Name);
  const on = agentsReachLanOn(bootstrap.burrow);
  const change = (next: boolean) =>
    set.mutateAsync({ params: { burrow }, body: { agentsReachLan: next } }).then(
      (result) =>
        toast.show(
          result.status === 'ok'
            ? next
              ? said.on
              : said.off
            : result.status === 'blocked'
              ? result.message
              : AGENTS_NETWORK_TEXT.failed,
        ),
      (e) => toast.show(e instanceof ApiError && e.message ? e.message : AGENTS_NETWORK_TEXT.failed),
    );
  return (
    <>
      <section
        id={LOCAL_NETWORK_ANCHOR}
        className={styles.section}
        aria-labelledby={`${ids}-label`}
        data-agents-network=""
      >
        <SectionLabel as="h2" id={`${ids}-label`}>
          {AGENTS_NETWORK_TEXT.label}
        </SectionLabel>
        <div className={styles.card}>
          <div className={cx(styles.row, styles.lastRow)}>
            <span className={styles.rowMain}>
              <label className={styles.rowTitle} htmlFor={`${ids}-lan`}>
                {said.label}
              </label>
              <span className={styles.rowMeta} id={`${ids}-hint`}>
                {said.hint}
              </span>
            </span>
            <Toggle
              id={`${ids}-lan`}
              checked={on}
              disabled={set.isPending}
              aria-describedby={`${ids}-hint`}
              onCheckedChange={(next) => void change(next)}
            />
          </div>
        </div>
      </section>
      {on ? null : <ClosedNetworks />}
    </>
  );
}

/** The home networks and ports still open while the local network is closed (the Vault's and Connections' list). */
function ClosedNetworks() {
  const networks = useVaultNetworks({});
  return <HomeNetwork query={networks} addBehindButton />;
}
