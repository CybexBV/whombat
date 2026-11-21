import { permissionsText } from '@whombat/client';
import { useCommandAllowances, useHostInfo, useSetAgentKeys } from '@whombat/client/react';
import {
  type ConfigureKeyState,
  configureGrants,
  configureKeyState,
  configureKeyTiers,
  isThreeStateOption,
  type KeyId,
  type KeyTiers,
  keyLabel,
  RISK_KEY_OPTIONS,
  type Tier,
} from '@whombat/core/keys';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SectionLabel } from '../../../components/SectionLabel';
import { useToast } from '../../../components/Toast';
import { TierRow, ToggleRow } from '../../../components/Toggle';
import settings from '../../settings/SettingsScreen.module.css';
import { KeyTierRows } from '../KeyTierRows';
import { useKeyLinks } from '../keyLinks';
import {
  allKeyOptions,
  keyPlace,
  keyRowOptions,
  liveKeyRows,
  ownKeyOptions,
  TIER_SEGMENTS,
  tierKeyRows,
} from '../liveKeys';
import type { SettingsTabProps } from './AgentTab';
import styles from './AgentTab.module.css';
import { CommandAllowances } from './CommandAllowances';
import { outcomeNotice, savedText } from './model';
import p from './Permissions.module.css';
import { SaveBar } from './SaveBar';
import { useDraft } from './useDraft';

interface KeysDraft {
  /** The switches of All keys. */
  keys: ConfigureKeyState;
  /** The rows (Off · Ask · On by row key) and All keys' three-state keys (`connections.write`): `configureKeyTiers`. */
  tiers: KeyTiers;
}

/** All keys' line (ours, AP-679). */
export const ALL_KEYS_LABEL = 'All keys';
export const allKeysHint = (agent: string) =>
  `Everything else ${agent} may do. Switch off what ${agent} shouldn’t have.`;

/**
 * What {assistant} may do → **KEYS** (Whombat one-agent.md OA-05, OA-09; settings-groups.md): the six rows by risk —
 * Just watch · Ask me first · Go ahead — then **All keys**, folded: every other key as a switch (a pack's write tools as
 * a three-state row of its own); then **Always allowed commands**, folded with how many there are: the commands the
 * person allowed for good, each with Remove. The keys are a draft saved with Save (only what changed, applied to what
 * the assistant holds now — `configureGrants`); removing a command is at once. `showKey` (`&key=`, a skill's “Turn on …”
 * link) opens All keys when the key is there and shows the row.
 */
export function KeysSection({
  burrow,
  profile,
  onDirtyChange,
  showKey,
}: SettingsTabProps & { showKey?: string | undefined }) {
  const { agent } = profile;
  const t = permissionsText(agent.name);
  const ids = useId();
  const { data: host } = useHostInfo({ params: { burrow } });
  const allowances = useCommandAllowances({ params: { burrow } });
  const setKeys = useSetAgentKeys(burrow);
  const keyLinks = useKeyLinks('agent-settings');
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const rowOptions = keyRowOptions(RISK_KEY_OPTIONS);
  const allOptions = ownKeyOptions(allKeyOptions());
  const options = [...rowOptions, ...allOptions];
  const [allOpen, setAllOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const form = useDraft<KeysDraft>({
    keys: configureKeyState(profile.grants, allOptions),
    tiers: configureKeyTiers(profile.grants, options),
  });
  // The assistant as last fetched: a save applies the change to what it holds now.
  const latest = useRef(profile);
  latest.current = profile;
  useEffect(() => onDirtyChange(form.dirty), [form.dirty, onDirtyChange]);

  // A skill's “Turn on …” link: show that row once it is on the page, opening All keys for one of its.
  const shown = useRef<string | null>(null);
  const hasDraft = !!form.draft;
  const target = showKey ? keyPlace(showKey as KeyId, rowOptions, allOptions) : null;
  useEffect(() => {
    if (!showKey || !hasDraft || shown.current === showKey) return;
    shown.current = showKey;
    if (target?.place === 'all') setAllOpen(true);
    const key = (target?.keyId ?? showKey) as KeyId;
    requestAnimationFrame(() => keyLinks.show(key));
  }, [showKey, hasDraft, target?.place, target?.keyId, keyLinks.show]);

  if (!form.draft) return null;
  const { draft } = form;
  const tierRowsNow = tierKeyRows(rowOptions, (row) => draft.tiers[row] ?? 'cannot', host?.deployWorkflow);
  const lockedRows = liveKeyRows(rowOptions, () => false);
  const switchRows = liveKeyRows(allOptions, (keyId) => !!draft.keys[keyId]);
  const switchesOn = switchRows.filter((r) => r.checked).length;
  const allOn =
    switchesOn + allOptions.filter((o) => isThreeStateOption(o) && draft.tiers[o.keyId] === 'can').length;
  const commands = allowances.data?.allowances.length;

  async function save() {
    if (!form.draft || !form.base) return;
    setNotice(null);
    const edit = {
      baseKeys: form.base.keys,
      keys: form.draft.keys,
      baseTiers: form.base.tiers,
      tiers: form.draft.tiers,
    };
    const grants = configureGrants(latest.current.grants, edit, options);
    if (grants) {
      const result = await setKeys.mutateAsync({ params: { burrow }, body: { grants } });
      const refused = outcomeNotice(result);
      if (refused) return setNotice(refused);
      form.saved((b) => ({ ...b, keys: edit.keys, tiers: edit.tiers }));
    }
    toast.show(savedText(agent.name, 'keys'));
  }

  return (
    <section className={settings.section} aria-labelledby={`${ids}-label`}>
      <SectionLabel as="h2" id={`${ids}-label`}>
        {t.keys}
      </SectionLabel>
      <div className={cx(settings.card, p.keys)} data-permissions="keys">
        <KeyTierRows
          rows={tierRowsNow}
          onChange={(row, tier) => form.edit((d) => ({ ...d, tiers: { ...d.tiers, [row]: tier } }))}
          keyLinks={keyLinks}
        />
        {lockedRows.map(({ option, note }) => (
          <ToggleRow
            key={option.keyId}
            label={keyLabel(option.keyId)}
            checked={false}
            locked
            note={note ?? undefined}
            id={keyLinks.rowId(option.keyId)}
            highlighted={keyLinks.highlighted === option.keyId}
          />
        ))}
        <Fold
          id={`${ids}-all`}
          label={ALL_KEYS_LABEL}
          meta={`${allOn} of ${allOptions.length} on`}
          open={allOpen}
          onToggle={() => setAllOpen((v) => !v)}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: a group of switches, not a form part. */}
          <div role="group" aria-label={ALL_KEYS_LABEL} className={styles.allKeys}>
            <p className={cx(styles.hint, styles.allKeysHint)}>{allKeysHint(agent.name)}</p>
            {allOptions.map((option) => {
              if (isThreeStateOption(option))
                return (
                  <TierRow<Tier>
                    key={option.keyId}
                    label={keyLabel(option.keyId)}
                    options={TIER_SEGMENTS}
                    value={draft.tiers[option.keyId] ?? option.defaultTier ?? 'ask'}
                    onChange={(next) =>
                      form.edit((d) => ({ ...d, tiers: { ...d.tiers, [option.keyId]: next } }))
                    }
                    id={keyLinks.rowId(option.keyId)}
                    highlighted={keyLinks.highlighted === option.keyId}
                  />
                );
              const row = switchRows.find((r) => r.option.keyId === option.keyId);
              if (!row) return null;
              return (
                <ToggleRow
                  key={option.keyId}
                  label={keyLabel(option.keyId)}
                  checked={row.checked}
                  onCheckedChange={(on) =>
                    form.edit((d) => ({ ...d, keys: { ...d.keys, [option.keyId]: on } }))
                  }
                  included={!!row.includedWith}
                  note={row.note ?? undefined}
                  id={keyLinks.rowId(option.keyId)}
                  highlighted={keyLinks.highlighted === option.keyId}
                />
              );
            })}
          </div>
        </Fold>
        {/* What was allowed for good on a command card: rarely looked at, so folded until opened. */}
        <Fold
          id={`${ids}-commands`}
          label={t.commandsFold}
          meta={commands === undefined ? '…' : t.commandsCount(commands)}
          open={commandsOpen}
          onToggle={() => setCommandsOpen((v) => !v)}
        >
          <CommandAllowances burrow={burrow} className={p.commands} />
        </Fold>
      </div>
      <SaveBar
        dirty={form.dirty}
        saving={setKeys.isPending}
        notice={notice}
        onSave={save}
        onDiscard={() => {
          setNotice(null);
          form.discard();
        }}
      />
    </section>
  );
}

/** A row that opens what is under it: the chevron, its name, the count on the right in mono. */
function Fold({
  id,
  label,
  meta,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={onToggle}
      >
        <Icon
          name="chevronDown"
          size={14}
          className={cx(styles.disclosureChevron, open && styles.disclosureOpen)}
        />
        <span className={styles.disclosureLabel}>{label}</span>
        <span className={styles.disclosureMeta}>{meta}</span>
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </>
  );
}
