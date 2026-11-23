/**
 * A connection's settings that are choices, changed later from its page (docs/implementation/macos/findmy-connection.md
 * §2.1): a `select` with its own options (Find My's Read in the background), and a choice the service gives when the
 * app knows the choices itself — the Mac of an entry checked through a Mac (Find My's), from the servers Whombat
 * watches. The rest of a `fromService` choice (Moneybird's administration) is only asked when connecting. Pure; the
 * web's ConnectionPage and the phone's Connection screen draw them as radio cards.
 */
import type { CatalogEntry } from '@whombat/core/domain';

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceSetting {
  /** The field's id (`background`, `mac`). */
  field: string;
  label: string;
  help: string | null;
  /** The value it has now; the field's default when it has none. */
  value: string;
  /** Its words: the option's label, or the value itself when no option has it (a Mac that is gone). */
  valueLabel: string;
  options: ChoiceOption[];
}

/** A Mac as the choices name it: its id in the hosts fleet and the name the person sees. */
export interface MacChoice {
  id: string;
  name: string;
}

/**
 * The choices a connection of `entry` may change later, in the form's order: a select's own options, and the Mac field
 * of an entry checked through a Mac with `macs` as its choices (none while the servers aren't known).
 */
export function choiceSettings(
  entry: Pick<CatalogEntry, 'fields' | 'check'>,
  fields: Readonly<Record<string, string>>,
  macs: readonly MacChoice[] | null,
): ChoiceSetting[] {
  const throughMac = entry.check?.kind === 'mac';
  return entry.fields.flatMap((f): ChoiceSetting[] => {
    if (f.kind !== 'select') return [];
    const options: ChoiceOption[] = f.options
      ? f.options.map((o) => ({ value: o.value, label: o.label }))
      : f.fromService && throughMac && f.id === 'mac' && macs?.length
        ? macs.map((m) => ({ value: m.id, label: m.name }))
        : [];
    if (!options.length) return [];
    const value = fields[f.id] ?? f.default ?? '';
    return [
      {
        field: f.id,
        label: f.label,
        help: f.help ?? null,
        value,
        valueLabel: options.find((o) => o.value === value)?.label ?? value,
        options,
      },
    ];
  });
}

/** The toast after a change: “Read in the background: Every 15 minutes.” */
export function choiceSavedText(setting: Pick<ChoiceSetting, 'label' | 'options'>, value: string): string {
  return `${setting.label}: ${setting.options.find((o) => o.value === value)?.label ?? value}.`;
}
