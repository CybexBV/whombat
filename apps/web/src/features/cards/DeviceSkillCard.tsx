import {
  DEVICE_TIER_LABELS,
  type DeviceActionChoice,
  type DeviceSkillCard as DeviceSkillCardData,
  deviceSkillCopy,
  limitText,
  type ToolArgLimit,
} from '@whombat/core';
import { Cpu, Lightbulb, type LucideIcon, Plug, Thermometer } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { TierRow } from '../../components/Toggle/TierRow';
import { useLocaleWords } from '../../i18n/words';
import styles from './DeviceSkillCard.module.css';

type Tier = DeviceActionChoice['tier'];
type Action = DeviceSkillCardData['actions'][number];

const TIER_OPTIONS = (['off', 'ask', 'can'] as const).map((value) => ({
  value,
  label: DEVICE_TIER_LABELS[value],
}));

/** The card's words that the contracts don't carry (mock 3). */
export const DEVICE_CARD_COPY = {
  newSkill: 'New skill · reads only, until you allow more',
  tested: 'Tested on your unit',
  mayChange: 'What I may change',
  foot: 'Everything else stays off. I tested this from your Whombat and wrote nothing to the unit.',
  showSkill: 'Show the skill',
  hideSkill: 'Hide the skill',
  onFoot: 'Switched on. I change only what you allowed, within your limits.',
  declinedFoot: 'Not switched on. Nothing was made, and I wrote nothing to the unit.',
  moreReadings: (n: number) => `+ ${n} more`,
} as const;

/** The glyph in the card's tile: a thermometer for heating, a bulb for lights, a plug for power, else a chip. */
function deviceGlyph(name: string): LucideIcon {
  if (/heat|temp|thermo|boiler|climate/i.test(name)) return Thermometer;
  if (/light|lamp|bulb/i.test(name)) return Lightbulb;
  if (/plug|power|meter|charger|inverter|solar|battery/i.test(name)) return Plug;
  return Cpu;
}

/** “Only between 16 and 24 °C”, else what the action does (“On or off”). */
export function actionLine(action: Action, choice: DeviceActionChoice): string {
  const limited = choice.tier !== 'off' && choice.limits ? limitText(choice.limits, action.unit) : null;
  return limited ? limited.charAt(0).toUpperCase() + limited.slice(1) : action.description;
}

/** Each action's choice: yours (once decided), else Whombat's proposal. */
export function initialChoices(card: DeviceSkillCardData): Record<string, DeviceActionChoice> {
  return Object.fromEntries(card.actions.map((a) => [a.key, card.decided?.[a.key] ?? a.proposed]));
}

export interface DeviceSkillCardProps {
  card: DeviceSkillCardData;
  choices: Record<string, DeviceActionChoice>;
  onChoice: (key: string, choice: DeviceActionChoice) => void;
  busy?: boolean;
  onSwitchOn: () => void;
  onDecline: () => void;
}

/**
 * A device skill (mock 3; one-whombat.md ONE-16…ONE-18; app one-whombat-shell.md AP-1274): what Whombat can read, with
 * the values from its read-only test, then every action with **Off · Ask me · Allowed** and your limits
 * (“Only between 16 and 24 °C”). Nothing changes on the device until you press **Switch on**. “Show the skill”
 * opens what the skill says it does; “Not now” there declines it.
 */
export function DeviceSkillCard({
  card,
  choices,
  onChoice,
  busy = false,
  onSwitchOn,
  onDecline,
}: DeviceSkillCardProps) {
  const DEVICE_SKILL_COPY = useLocaleWords(deviceSkillCopy);
  const [showing, setShowing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const titleId = useId();
  const proposed = card.status === 'proposed';
  const decidable = proposed && !busy;
  return (
    <section className={styles.card} aria-labelledby={titleId} data-device-skill={card.proposalId}>
      <div className={styles.top}>
        <span className={styles.sk} aria-hidden="true">
          <Icon icon={deviceGlyph(card.name)} size={18} />
        </span>
        <div className={styles.titles}>
          <h3 id={titleId}>{card.name}</h3>
          <p>{proposed ? DEVICE_CARD_COPY.newSkill : (card.model ?? DEVICE_SKILL_COPY.canRead)}</p>
        </div>
        <span className={cx(styles.badge, card.status === 'declined' && styles.badgeMut)}>
          {card.status === 'on'
            ? DEVICE_SKILL_COPY.on
            : card.status === 'declined'
              ? DEVICE_SKILL_COPY.declined
              : DEVICE_CARD_COPY.tested}
        </span>
      </div>

      <ul className={styles.reads} aria-label={DEVICE_SKILL_COPY.canRead}>
        {card.readings.map((r) => (
          <li key={r.key} className={styles.read}>
            {r.label}
            <b>{r.unit ? `${r.value} ${r.unit}` : r.value}</b>
          </li>
        ))}
        {card.moreReadings > 0 && (
          <li className={cx(styles.read, styles.readMore)}>
            {DEVICE_CARD_COPY.moreReadings(card.moreReadings)}
          </li>
        )}
      </ul>

      {card.actions.length > 0 && (
        <>
          <h4 className={styles.sublbl}>{DEVICE_CARD_COPY.mayChange}</h4>
          {card.actions.map((action) => {
            const choice = choices[action.key] ?? action.proposed;
            const limitable = action.valueType === 'number' && choice.tier !== 'off';
            return (
              <TierRow<Tier>
                key={action.key}
                variant="soft"
                className={styles.allow}
                label={action.label}
                hint={
                  <>
                    {actionLine(action, choice)}
                    {limitable && decidable && editing !== action.key ? (
                      <span className={styles.limitMore}>
                        {' · '}
                        <button
                          type="button"
                          className={styles.limitLink}
                          onClick={() => setEditing(action.key)}
                        >
                          {choice.limits ? 'Change limits' : 'Add limits'}
                        </button>
                      </span>
                    ) : null}
                  </>
                }
                options={TIER_OPTIONS}
                value={choice.tier}
                onChange={(tier) => onChoice(action.key, { ...choice, tier })}
                disabled={!decidable}
              >
                {editing === action.key && (
                  <LimitsEditor
                    action={action}
                    limits={choice.limits}
                    onDone={(limits) => {
                      onChoice(action.key, { tier: choice.tier, ...(limits ? { limits } : {}) });
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </TierRow>
            );
          })}
        </>
      )}

      {showing && <SkillDetails card={card} canDecline={decidable} onDecline={onDecline} />}

      <div className={styles.foot}>
        <p>
          {card.status === 'on'
            ? DEVICE_CARD_COPY.onFoot
            : card.status === 'declined'
              ? DEVICE_CARD_COPY.declinedFoot
              : DEVICE_CARD_COPY.foot}
        </p>
        <button
          type="button"
          className={styles.btn}
          aria-expanded={showing}
          onClick={() => setShowing((v) => !v)}
        >
          {showing ? DEVICE_CARD_COPY.hideSkill : DEVICE_CARD_COPY.showSkill}
        </button>
        {proposed && (
          <button
            type="button"
            className={cx(styles.btn, styles.primary)}
            disabled={!decidable}
            onClick={onSwitchOn}
            data-device-switch-on=""
          >
            {DEVICE_SKILL_COPY.switchOn}
          </button>
        )}
      </div>
    </section>
  );
}

/** What the skill says it does: every reading it takes and every action, with its range (“Show the skill”). */
function SkillDetails({
  card,
  canDecline,
  onDecline,
}: {
  card: DeviceSkillCardData;
  canDecline: boolean;
  onDecline: () => void;
}) {
  const DEVICE_SKILL_COPY = useLocaleWords(deviceSkillCopy);
  return (
    <div className={styles.details}>
      <h4 className={styles.sublbl}>{DEVICE_SKILL_COPY.canRead}</h4>
      <ul className={styles.detailList}>
        {card.readings.map((r) => (
          <li key={r.key}>
            {r.label}
            {r.unit ? <span> · {r.unit}</span> : null}
          </li>
        ))}
        {card.moreReadings > 0 && <li>and {card.moreReadings} more readings</li>}
      </ul>
      {card.actions.length > 0 && (
        <>
          <h4 className={styles.sublbl}>{DEVICE_SKILL_COPY.canChange}</h4>
          <ul className={styles.detailList}>
            {card.actions.map((a) => (
              <li key={a.key}>
                <b>{a.label}</b> · {a.description}
                {a.min !== undefined && a.max !== undefined ? (
                  <span>
                    {' '}
                    · the unit takes {a.min} to {a.max}
                    {a.unit ? ` ${a.unit}` : ''}
                  </span>
                ) : null}
                {a.sensitive ? <span> · always asks you</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={styles.detailNote}>{DEVICE_SKILL_COPY.nothingChanges}</p>
      {canDecline && (
        <button type="button" className={styles.btn} onClick={onDecline} data-device-decline="">
          {DEVICE_SKILL_COPY.decline}
        </button>
      )}
    </div>
  );
}

/** “Only between [16] and [24] °C”: your limits on a number action, within what the unit takes. */
function LimitsEditor({
  action,
  limits,
  onDone,
  onCancel,
}: {
  action: Action;
  limits: ToolArgLimit | undefined;
  onDone: (limits: ToolArgLimit | null) => void;
  onCancel: () => void;
}) {
  const [min, setMin] = useState(limits?.min !== undefined ? String(limits.min) : '');
  const [max, setMax] = useState(limits?.max !== undefined ? String(limits.max) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const lo = min.trim() === '' ? undefined : Number(min);
    const hi = max.trim() === '' ? undefined : Number(max);
    if ((lo !== undefined && !Number.isFinite(lo)) || (hi !== undefined && !Number.isFinite(hi))) {
      setProblem('Use numbers here.');
      return;
    }
    if (lo !== undefined && hi !== undefined && lo > hi) {
      setProblem('The lowest is above the highest.');
      return;
    }
    if (
      (action.min !== undefined && lo !== undefined && lo < action.min) ||
      (action.max !== undefined && hi !== undefined && hi > action.max)
    ) {
      setProblem(`The unit takes ${action.min} to ${action.max}${action.unit ? ` ${action.unit}` : ''}.`);
      return;
    }
    onDone(
      lo === undefined && hi === undefined
        ? null
        : { ...(lo !== undefined ? { min: lo } : {}), ...(hi !== undefined ? { max: hi } : {}) },
    );
  };
  return (
    <form className={styles.limits} onSubmit={submit} aria-label={`Limits for ${action.label}`}>
      <label htmlFor={`${id}-min`}>Only between</label>
      <input
        id={`${id}-min`}
        className={styles.limitInput}
        inputMode="decimal"
        value={min}
        placeholder={action.min !== undefined ? String(action.min) : ''}
        onChange={(e) => setMin(e.target.value)}
      />
      <label htmlFor={`${id}-max`}>and</label>
      <input
        id={`${id}-max`}
        className={styles.limitInput}
        inputMode="decimal"
        value={max}
        placeholder={action.max !== undefined ? String(action.max) : ''}
        onChange={(e) => setMax(e.target.value)}
      />
      {action.unit ? <span>{action.unit}</span> : null}
      <button type="submit" className={cx(styles.btn, styles.primary)}>
        Done
      </button>
      <button type="button" className={styles.btn} onClick={onCancel}>
        Cancel
      </button>
      {problem && (
        <p className={styles.limitProblem} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
