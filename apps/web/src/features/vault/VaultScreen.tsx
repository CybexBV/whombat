import { Link } from '@tanstack/react-router';
import { VAULT_ROW_TEXT } from '@whombat/client';
import { useTheAgent, useVault } from '@whombat/client/react';
import { VAULT_LIMIT_MESSAGES } from '@whombat/core/contracts';
import { VAULT_COPY } from '@whombat/core/vault';
import { LOCAL_NETWORK_ANCHOR } from '../../app/routing/search';
import { Button } from '../../components/Button';
import { PlacePage, placeStyles as place } from '../settings/Place';
import { VAULT_TEXT } from './copy';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';
import { VaultTab } from './VaultTab';

export interface VaultScreenProps {
  burrow: string;
  /** The entry shown open (`?entry=`). */
  entry?: string;
  /** Opens or closes an entry (updates `?entry=`). */
  onEntryChange?: (entryId: string | undefined) => void;
  /** Add to Vault open (`?add=1`, the sidebar's menu, AP-4507). */
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
}

/**
 * The Vault as a page of its own (`/vault`; the final design, docs/decisions/final-settings-vault-files-usage.md): its
 * title and one line on what it holds, Add to Vault beside them (on a line of its own when there is no room: a narrow
 * window, large text), the entries, then what the Vault never shows, what saving from chat does, and one quiet line
 * to the home network ranges, under the local network switch on What the assistant may do.
 */
export function VaultScreen({ burrow, entry, onEntryChange, adding, onAddingChange }: VaultScreenProps) {
  const words = useVaultWords(burrow);
  const agent = useTheAgent(burrow).words.name;
  const { data } = useVault({ params: { burrow } });
  return (
    <PlacePage
      screen="vault"
      title={VAULT_COPY.title}
      intro={VAULT_ROW_TEXT.intro(agent)}
      action={
        data ? (
          <Button
            variant="primary"
            size="lg"
            disabled={!data.canAdd}
            title={data.canAdd ? undefined : VAULT_LIMIT_MESSAGES.entries}
            onClick={() => onAddingChange?.(true)}
          >
            {VAULT_COPY.add}
          </Button>
        ) : null
      }
    >
      <VaultTab
        burrow={burrow}
        open={entry}
        onOpenChange={onEntryChange}
        adding={adding}
        onAddingChange={onAddingChange}
      />
      <div className={styles.pageNotes}>
        <p className={place.note}>{VAULT_ROW_TEXT.closed}</p>
        {words.savedIntro ? <p className={place.note}>{words.savedIntro}</p> : null}
        <p className={place.note} data-note="home-network">
          {words.homeNetworkElsewhere}{' '}
          <Link to="/settings" search={{ tab: 'agent', part: 'may' }} hash={LOCAL_NETWORK_ANCHOR}>
            {VAULT_TEXT.homeNetworkLink}
          </Link>
        </p>
      </div>
    </PlacePage>
  );
}
