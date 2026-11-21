import type { Tier } from '@whombat/core/keys';
import { TierRow } from '../../components/Toggle';
import type { useKeyLinks } from './keyLinks';
import { TIER_SEGMENTS, type TierKeyRow } from './liveKeys';

/**
 * The risk rows (AP-678, AP-679): each row's label (“Merge into main”, “Money”), Off · Ask · On, and core's line under
 * it — Deploy's “No deploy workflow is set up on this Whombat yet.” after it when the Whombat has none (MDS-05), as
 * Settings → Agent → Keys draws them.
 */
export function KeyTierRows({
  rows,
  onChange,
  keyLinks,
}: {
  rows: readonly TierKeyRow[];
  onChange: (row: TierKeyRow['row'], tier: Tier) => void;
  keyLinks: ReturnType<typeof useKeyLinks>;
}) {
  return rows.map(({ option, row, tier, label, description, hint }) => (
    <TierRow<Tier>
      key={row}
      label={label}
      options={TIER_SEGMENTS}
      value={tier}
      onChange={(next) => onChange(row, next)}
      hint={
        hint ? (
          <>
            {description} <span>{hint}</span>
          </>
        ) : (
          description
        )
      }
      id={keyLinks.rowId(option.keyId)}
      highlighted={keyLinks.highlighted === option.keyId}
    />
  ));
}
