/**
 * A service's settings (Whombat service-settings.md SST-01, SST-03, SST-05, SST-09; mock service-dash-v2 screens 2 and
 * 3): a card per group, each row a setting's name, its sentence, who changed it last with **Put it back**, its value in
 * words, then a switch (flips at once, the new state shown until the page is read again), **Change** (opens the sheet
 * of choices) or where it is changed instead (“In Plex”, a link in a new tab). A switch or Change the viewer may not
 * use stays in place, greyed, with the server's reason. The sheet's “Change it” and the switch run the kind's `setting`
 * action through the page's buttons, the same action the assistant runs; the toast says what the service now says.
 *
 * On a settings tab the line before the cards and the “Something else?” card after them are drawn here too.
 */
import { guessedOn, switchValue, thingButtonView } from '@whombat/client';
import { useControlGuesses, useTheAgent } from '@whombat/client/react';
import type { ThingButtonValue, ThingPagePanel, ThingSetting, ThingSettingChoose } from '@whombat/core';
import { Check, ExternalLink, MessageCircle, Undo2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { Toggle } from '../../../components/Toggle';
import { PrincipalAvatar } from '../../messaging/PrincipalAvatar';
import { Card } from '../parts';
import things from '../Things.module.css';
import { type DashboardContext, PageLink, PanelHead } from './Panels';
import service from './Service.module.css';
import styles from './Settings.module.css';

type SettingsPanel = Extract<ThingPagePanel, { kind: 'settings' }>;
type TextPanel = Extract<ThingPagePanel, { kind: 'text' }>;
type Guesses = ReturnType<typeof useControlGuesses>;

export function SettingsPanelView({ panel, ctx }: { panel: SettingsPanel; ctx: DashboardContext }) {
  const guesses = useControlGuesses(ctx.readAt ?? 0);
  // The setting whose sheet is open (one at a time).
  const [sheet, setSheet] = useState<string | null>(null);
  if (!panel.rows.length && !panel.empty) return null;
  const open = panel.rows.find((r) => r.id === sheet && r.choose);
  return (
    <Card title={panel.title} meta={panel.meta} link={<PanelHead panel={panel} ctx={ctx} />}>
      {panel.hint ? <p className={styles.hint}>{panel.hint}</p> : null}
      {panel.rows.length ? (
        <ul className={styles.rows}>
          {panel.rows.map((row) => (
            <SettingRow
              key={row.id}
              row={row}
              ctx={ctx}
              guesses={guesses}
              onChange={() => setSheet(row.id)}
            />
          ))}
        </ul>
      ) : (
        <p className={service.quiet}>{panel.empty}</p>
      )}
      {open?.choose ? (
        <SettingSheet row={open} choose={open.choose} ctx={ctx} onClose={() => setSheet(null)} />
      ) : null}
    </Card>
  );
}

function SettingRow({
  row,
  ctx,
  guesses,
  onChange,
}: {
  row: ThingSetting;
  ctx: DashboardContext;
  guesses: Guesses;
  onChange: () => void;
}) {
  const uid = useId();
  const labelId = `${uid}-l`;
  const helpId = `${uid}-h`;
  const valueId = `${uid}-v`;
  const on = row.toggle ? guessedOn({ id: row.id, on: row.on }, guesses.guesses) : !!row.on;
  // While a flip is on its way the words follow the switch; the page's own words come back with the next read.
  const value = row.toggle && on !== !!row.on ? (on ? 'On' : 'Off') : row.value;
  const putting = row.changed?.changeId ? ctx.puttingBack === row.changed.changeId : false;
  return (
    <li className={cx(styles.row, row.changed?.changeId && styles.rowFresh)} data-setting={row.id}>
      <div className={styles.words}>
        <b id={labelId} className={styles.name}>
          {row.label}
        </b>
        {row.help ? (
          <span id={helpId} className={styles.help}>
            {row.help}
          </span>
        ) : null}
        {row.changed ? (
          <span className={styles.was}>
            <Icon icon={Undo2} size={14} className={styles.wasIcon} />
            <span>{row.changed.text}</span>
            {row.changed.changeId && ctx.putBack ? (
              <button
                type="button"
                className={styles.putBack}
                aria-label={`Put ${row.label} back`}
                aria-busy={putting || undefined}
                aria-disabled={putting || undefined}
                onClick={() => {
                  if (!putting && row.changed?.changeId) ctx.putBack?.(row.changed.changeId);
                }}
              >
                Put it back
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      <span id={valueId} className={styles.value}>
        {value}
      </span>
      {row.toggle ? (
        <SettingSwitch
          row={row}
          toggle={row.toggle}
          on={on}
          ctx={ctx}
          guesses={guesses}
          labelId={labelId}
          describedBy={row.help ? helpId : undefined}
        />
      ) : row.choose ? (
        <ChangeButton button={row.choose.button} ctx={ctx} label={row.label} onOpen={onChange} />
      ) : row.elsewhere ? (
        row.elsewhere.url ? (
          <a
            href={row.elsewhere.url}
            target="_blank"
            rel="noreferrer"
            className={styles.elsewhere}
            aria-label={`${row.label}: change it ${row.elsewhere.label.replace(/^In /, 'in ')}`}
          >
            {row.elsewhere.label}
          </a>
        ) : (
          <span className={styles.elsewhere}>{row.elsewhere.label}</span>
        )
      ) : null}
    </li>
  );
}

function SettingSwitch({
  row,
  toggle,
  on,
  ctx,
  guesses,
  labelId,
  describedBy,
}: {
  row: ThingSetting;
  toggle: NonNullable<ThingSetting['toggle']>;
  on: boolean;
  ctx: DashboardContext;
  guesses: Guesses;
  labelId: string;
  describedBy: string | undefined;
}) {
  const buttons = ctx.buttons;
  const view = thingButtonView(toggle);
  const reasonId = useId();
  const next = switchValue(on);
  const busy = buttons?.running(toggle, next) || buttons?.running(toggle, !next) || false;
  const off = view.disabled || !buttons;
  const described = [describedBy, view.reason ? reasonId : null].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <Toggle
        checked={on}
        className={cx(styles.switch, off && styles.switchOff)}
        aria-labelledby={labelId}
        aria-describedby={described}
        aria-disabled={off || undefined}
        aria-busy={busy || undefined}
        title={view.reason ?? undefined}
        onCheckedChange={() => {
          if (off || busy || !buttons) return;
          buttons.press(toggle, {
            value: next,
            onSend: () => guesses.guess(row.id, next),
            onDone: (r) => {
              if (r.sent) guesses.done(row.id, r);
            },
          });
        }}
      />
      {view.reason ? (
        <span id={reasonId} className={things.srOnly}>
          {view.reason}
        </span>
      ) : null}
    </>
  );
}

/** Change: opens the sheet; greyed with the server's reason for a viewer who may not change it. */
function ChangeButton({
  button,
  ctx,
  label,
  onOpen,
}: {
  button: ThingSettingChoose['button'];
  ctx: DashboardContext;
  label: string;
  onOpen: () => void;
}) {
  const view = thingButtonView(button);
  const reasonId = useId();
  const off = view.disabled || !ctx.buttons;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        className={cx(service.tbtn, service.tbtnPlain, styles.change)}
        aria-label={`${view.label} ${label}`}
        aria-haspopup={off ? undefined : 'dialog'}
        aria-disabled={off || undefined}
        aria-describedby={view.reason ? reasonId : undefined}
        title={view.reason ?? undefined}
        onClick={() => {
          if (!off) onOpen();
        }}
      >
        {view.label}
      </Button>
      {view.reason ? (
        <span id={reasonId} className={things.srOnly}>
          {view.reason}
        </span>
      ) : null}
    </>
  );
}

const sameValue = (a: ThingButtonValue | null | undefined, b: ThingButtonValue | null | undefined) =>
  a !== undefined && b !== undefined && a !== null && b !== null && String(a) === String(b);

/**
 * The sheet (SST-09, mock screen 3): the setting's name, a sentence, the choices with “Now” on the current one, the hint
 * Whombat has, and **Ask {assistant} instead** · Cancel · **Change it** (only once another choice is picked). It stays
 * up, busy, until the service answered; the toast says how it went.
 */
export function SettingSheet({
  row,
  choose,
  ctx,
  onClose,
}: {
  row: Pick<ThingSetting, 'id' | 'label'>;
  choose: ThingSettingChoose;
  ctx: DashboardContext;
  onClose: () => void;
}) {
  const { words } = useTheAgent(ctx.burrow);
  const [picked, setPicked] = useState<ThingButtonValue | null>(choose.current);
  const [busy, setBusy] = useState(false);
  const name = useId();
  const changed = picked !== null && !sameValue(picked, choose.current);
  const close = () => {
    if (!busy) onClose();
  };
  const send = () => {
    if (!changed || busy || !ctx.buttons || picked === null) return;
    setBusy(true);
    ctx.buttons.press(choose.button, {
      value: picked,
      onDone: () => {
        setBusy(false);
        onClose();
      },
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && close()} width="md" className={styles.sheet}>
      <ModalTitle className={styles.sheetTitle}>{row.label}</ModalTitle>
      {choose.help ? <ModalDescription className={styles.sheetHelp}>{choose.help}</ModalDescription> : null}
      <fieldset className={styles.choices} aria-busy={busy || undefined}>
        <legend className={things.srOnly}>{row.label}</legend>
        {choose.choices.map((c) => {
          const now = sameValue(c.value, choose.current);
          const on = sameValue(c.value, picked);
          return (
            <label key={String(c.value)} className={cx(styles.choice, on && styles.choicePicked)}>
              <input
                type="radio"
                name={name}
                className={styles.radio}
                checked={on}
                disabled={busy}
                onChange={() => setPicked(c.value)}
              />
              <span className={styles.choiceWords}>
                <b>{c.label}</b>
                {c.note ? <span className={styles.choiceNote}> · {c.note}</span> : null}
              </span>
              {now ? <span className={styles.now}>Now</span> : null}
            </label>
          );
        })}
      </fieldset>
      {choose.hint ? (
        <p className={styles.sheetHint}>
          <Icon icon={Check} size={16} className={styles.sheetHintIcon} />
          <span>{choose.hint}</span>
        </p>
      ) : null}
      <div className={styles.sheetFoot}>
        <button
          type="button"
          className={styles.instead}
          disabled={busy}
          onClick={() => {
            onClose();
            ctx.onAsk(`Help me choose ${row.label} for ${ctx.thing.name}.`);
          }}
        >
          <Icon icon={MessageCircle} size={16} />
          Ask {words.Name} instead
        </button>
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={send}
          disabled={!changed || busy || !ctx.buttons}
          aria-busy={busy || undefined}
        >
          Change it
        </Button>
      </div>
    </Modal>
  );
}

/** The settings tab's first line (SST-07): a sentence and “All settings in Plex” in a new tab. */
export function SettingsLead({ panel, ctx }: { panel: TextPanel; ctx: DashboardContext }) {
  const link = panel.link;
  return (
    <p className={styles.lead}>
      <span>{panel.body}</span>
      {link?.kind === 'url' ? (
        <a href={link.url} target="_blank" rel="noreferrer" className={styles.leadLink}>
          <Icon icon={ExternalLink} size={14} />
          {link.label}
        </a>
      ) : link ? (
        <PageLink link={link} ctx={ctx} className={styles.leadLink} />
      ) : null}
    </p>
  );
}

/** “Something else?” at the end of a settings tab (SST-07): the assistant's face, its words and its Ask. */
export function SettingsFoot({ panel, ctx }: { panel: TextPanel; ctx: DashboardContext }) {
  const { agent } = useTheAgent(ctx.burrow);
  const headId = useId();
  return (
    <section className={cx(things.card, styles.foot)} aria-labelledby={headId}>
      {agent ? <PrincipalAvatar principal={agent} size={34} /> : null}
      <div className={styles.footWords}>
        <h2 id={headId} className={styles.footTitle}>
          {panel.title}
        </h2>
        <span>{panel.body}</span>
      </div>
      {panel.link?.kind === 'ask' ? (
        <Button
          size="sm"
          variant="secondary"
          className={styles.footAsk}
          iconStart={<Icon icon={MessageCircle} size={15} />}
          onClick={() => panel.link?.kind === 'ask' && ctx.onAsk(panel.link.question)}
        >
          {panel.link.label}
        </Button>
      ) : panel.link ? (
        <PageLink link={panel.link} ctx={ctx} look="button" />
      ) : null}
    </section>
  );
}
