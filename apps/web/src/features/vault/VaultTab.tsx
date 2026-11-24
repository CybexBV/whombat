/**
 * The Vault's list (`/vault`; docs/decisions/vault.md VT-70, VT-71; the final design,
 * docs/design-handoff/council-ui-2026-11/16-final/vault/, docs/decisions/final-settings-vault-files-usage.md; the page
 * around it is `VaultScreen`): one card of entries, each a row that opens in place into the entry's blocks. Only a
 * failing entry is drawn loud; a secret's value is never shown, only replaced. Loading, empty and failed reads each have
 * a card of their own. Only the viewer's own entries are ever here: another person's entry is a plain 404.
 */
import { VAULT_ROW_TEXT, vaultEntrySourceLine, vaultEntryTag, vaultRowLine } from '@whombat/client';
import { useTheAgent, useVault, useVaultNetworks } from '@whombat/client/react';
import { VAULT_LIMIT_MESSAGES } from '@whombat/core/contracts';
import { VAULT_COPY, type VaultEntry, type VaultNetwork, vaultEntryWhere } from '@whombat/core/vault';
import { Lock } from 'lucide-react';
import { useId, useState } from 'react';
import { Tag } from '../../components/Tag';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { errorDetail, PlaceRowBody, PlaceState, placeStyles as place } from '../settings/Place';
import { AddToVaultModal } from './AddToVaultModal';
import { vaultEntryLine } from './copy';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';
import { VaultEntryDetailView } from './VaultEntryDetail';

export interface VaultTabProps {
  burrow: string;
  /** The entry shown open (`&entry=`); the tab keeps its own when the URL doesn't. */
  open?: string;
  onOpenChange?: (entryId: string | undefined) => void;
  /** Add to Vault open (`?add=1`, AP-4507); the tab keeps its own when the URL doesn't. */
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
}

export function VaultTab({ burrow, open, onOpenChange, adding: asked, onAddingChange }: VaultTabProps) {
  const query = useVault({ params: { burrow } });
  const networks = useVaultNetworks({});
  const [ownOpen, setOwnOpen] = useState<string | undefined>(open);
  const [ownAdding, setOwnAdding] = useState(false);
  const setAdding = onAddingChange ?? setOwnAdding;
  const current = onOpenChange ? open : ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const data = query.data;

  return (
    <>
      {query.error && !data ? (
        <PlaceState
          kind="failed"
          icon={Lock}
          title={VAULT_ROW_TEXT.failedTitle}
          line={VAULT_ROW_TEXT.failedLine}
          retryLabel={VAULT_ROW_TEXT.retry}
          onRetry={() => void query.refetch()}
          detail={errorDetail(query.error)}
        />
      ) : !data ? (
        <PlaceState kind="loading" icon={Lock} title={VAULT_ROW_TEXT.loading} />
      ) : data.entries.length === 0 ? (
        <PlaceState kind="empty" icon={Lock} title={VAULT_ROW_TEXT.emptyTitle} line={VAULT_COPY.noEntries} />
      ) : (
        <ul className={place.card} aria-label={VAULT_COPY.entries}>
          {data.entries.map((entry) => (
            <EntryRow
              key={entry.id}
              burrow={burrow}
              entry={entry}
              open={current === entry.id}
              onToggle={() => setOpen(current === entry.id ? undefined : entry.id)}
              onRemoved={() => setOpen(undefined)}
            />
          ))}
        </ul>
      )}
      {data && !data.canAdd && <p className={styles.hint}>{VAULT_LIMIT_MESSAGES.entries}</p>}

      <AddToVaultModal
        burrow={burrow}
        // Not past the Vault's limit, even when the address asks for it.
        open={(onAddingChange ? !!asked : ownAdding) && !!data?.canAdd}
        onOpenChange={setAdding}
        networks={networks.data?.networks ?? NO_NETWORKS}
        onAdded={(entryId) => setOpen(entryId)}
      />
    </>
  );
}

const NO_NETWORKS: VaultNetwork[] = [];

/**
 * One entry: its lock, the name and one line — how its check went and when it was last used, or, only when its check
 * is failing, why in the Not working colour — opening in place to what it is, where it points and its detail. An entry
 * kept in step with 1Password carries its tag after the name, and its open detail says how it stands there.
 */
function EntryRow({
  burrow,
  entry,
  open,
  onToggle,
  onRemoved,
}: {
  burrow: string;
  entry: VaultEntry;
  open: boolean;
  onToggle: () => void;
  onRemoved: () => void;
}) {
  const viewer = useBurrowViewer(burrow);
  const words = useVaultWords(burrow);
  const { words: agent } = useTheAgent(burrow);
  const detailId = useId();
  const line = vaultRowLine(entry, { now: Date.now(), timeZone: viewer.timeZone, agent: agent.name });
  const where = vaultEntryWhere(entry);
  const tag = vaultEntryTag(entry);
  const source = vaultEntrySourceLine(entry, Date.now(), viewer.timeZone);
  return (
    <li className={styles.entry} data-open={open || undefined} data-entry={entry.id}>
      <button
        type="button"
        className={place.row}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={onToggle}
      >
        <PlaceRowBody
          icon={Lock}
          name={
            tag ? (
              <span className={styles.entryName}>
                <span>{entry.name}</span>
                <Tag data-source-tag="">{tag}</Tag>
              </span>
            ) : (
              entry.name
            )
          }
          line={<span data-problem={line.failing ? '' : undefined}>{line.text}</span>}
          bad={line.failing}
        />
      </button>
      {open && (
        <div id={detailId} className={styles.detail}>
          <p className={styles.detailWhat}>
            <span>{vaultEntryLine(entry, words)}</span>
            {where ? (
              <>
                {' · '}
                <span className={entry.kind === 'ssh' ? undefined : styles.monoWhere}>{where}</span>
              </>
            ) : null}
          </p>
          {source && (
            <p
              className={styles.detailWhat}
              data-source=""
              data-tone={source.tone === 'warn' ? 'warn' : undefined}
            >
              {source.text}
            </p>
          )}
          <VaultEntryDetailView burrow={burrow} entryId={entry.id} onRemoved={onRemoved} />
        </div>
      )}
    </li>
  );
}
