/**
 * Controls (contracts 0.121 `controls`, CT-1005; Whombat service-dashboards.md SD-30; service-dashboards.md AP-4565):
 * things to operate, grouped by room or kind, each group a section of tiles. A tile has its icon (lit while on), label
 * and state words, and one of: a switch (`toggle`, sends `value: !on`), a −/+ stepper (sends the new figure within
 * min…max once the presses stop), buttons (Activate, Lock, Open · Stop · Close), or a picture (a camera's snapshot). A
 * switch or stepper shows what the person set at once and keeps it until the page is read again after the answer; a
 * failure puts the page's state back and the toast says why. One the viewer may not use stays in place, greyed, with
 * the server's reason.
 */
import {
  type ControlGuesses,
  type ThingControlsPanel as ControlsPanel,
  guessedOn,
  guessedStep,
  stepperCan,
  stepperWords,
  switchValue,
  thingButtonView,
  thingControlLook,
} from '@whombat/client';
import { type ThingButtons, useControlGuesses, useStepperDraft } from '@whombat/client/react';
import type { ThingControl, ThingControlStepper } from '@whombat/core';
import { Minus, Plus, ToggleRight } from 'lucide-react';
import { useId } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Toggle } from '../../../components/Toggle';
import { Card } from '../parts';
import things from '../Things.module.css';
import { CONTROL_ICONS } from '../thingIcons';
import { ThingButtonRow } from './Buttons';
import { type DashboardContext, PanelHead } from './Panels';
import { Picture } from './Picture';
import styles from './Service.module.css';

type Guesses = ReturnType<typeof useControlGuesses>;

export function ControlsPanelView({ panel, ctx }: { panel: ControlsPanel; ctx: DashboardContext }) {
  const guesses = useControlGuesses(ctx.readAt ?? 0);
  const groups = panel.groups.filter((g) => g.items.length);
  if (!groups.length && !panel.empty && !panel.hint) return null;
  return (
    <Card title={panel.title} meta={panel.meta} link={<PanelHead panel={panel} ctx={ctx} />}>
      {panel.hint ? <p className={styles.ctlHint}>{panel.hint}</p> : null}
      {groups.length ? (
        <div className={styles.ctlGroups}>
          {groups.map((g) => (
            <ControlGroup key={g.id} id={g.id} title={g.title} items={g.items} ctx={ctx} guesses={guesses} />
          ))}
        </div>
      ) : panel.empty ? (
        <p className={styles.quiet}>{panel.empty}</p>
      ) : null}
    </Card>
  );
}

function ControlGroup({
  id,
  title,
  items,
  ctx,
  guesses,
}: {
  id: string;
  title: string;
  items: readonly ThingControl[];
  ctx: DashboardContext;
  guesses: Guesses;
}) {
  const headId = `${useId()}-${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <section aria-labelledby={headId}>
      <h3 id={headId} className={cx(things.lbl, styles.ctlGroupTitle)}>
        {title}
      </h3>
      <ul className={styles.ctlGrid}>
        {items.map((c) => (
          <ControlTile key={c.id} control={c} ctx={ctx} guesses={guesses} />
        ))}
      </ul>
    </section>
  );
}

const STATE_TONES = { ok: undefined, warn: styles.ctlWarn, bad: styles.ctlBad } as const;

function ControlTile({
  control,
  ctx,
  guesses,
}: {
  control: ThingControl;
  ctx: DashboardContext;
  guesses: Guesses;
}) {
  const uid = useId();
  const labelId = `${uid}-l`;
  const stateId = `${uid}-s`;
  const look = thingControlLook(control);
  const on = look === 'switch' ? guessedOn(control, guesses.guesses) : !!control.on;
  const glyph = control.icon ? CONTROL_ICONS[control.icon] : ToggleRight;
  return (
    <li
      className={cx(styles.ctl, on && styles.ctlOn, look === 'image' && styles.ctlImage)}
      data-control={control.id}
    >
      {look === 'image' && control.image ? (
        <Picture
          burrow={ctx.burrow}
          thing={ctx.thing.id}
          image={control.image}
          shape={control.image.shape}
          title={control.label}
          className={styles.ctlPic}
        />
      ) : null}
      <div className={styles.ctlTop}>
        {look === 'image' ? null : (
          <span className={styles.ctlIcon} aria-hidden="true">
            <Icon icon={glyph} size={17} />
          </span>
        )}
        <div className={styles.ctlWords}>
          <b id={labelId} className={styles.ctlLabel}>
            {control.label}
          </b>
          {control.state ? (
            <span id={stateId} className={cx(styles.ctlState, control.tone && STATE_TONES[control.tone])}>
              {control.state}
            </span>
          ) : null}
        </div>
        {look === 'switch' && control.toggle ? (
          <ControlSwitch
            control={control}
            toggle={control.toggle}
            on={on}
            buttons={ctx.buttons}
            guesses={guesses}
            labelId={labelId}
            stateId={control.state ? stateId : undefined}
          />
        ) : null}
      </div>
      {look === 'stepper' && control.stepper ? (
        <ControlStepper control={control} stepper={control.stepper} buttons={ctx.buttons} guesses={guesses} />
      ) : null}
      {look === 'buttons' ? (
        <ThingButtonRow
          items={control.buttons}
          buttons={ctx.buttons}
          className={styles.ctlButtons}
          label={control.label}
        />
      ) : null}
    </li>
  );
}

function ControlSwitch({
  control,
  toggle,
  on,
  buttons,
  guesses,
  labelId,
  stateId,
}: {
  control: ThingControl;
  toggle: NonNullable<ThingControl['toggle']>;
  on: boolean;
  buttons: ThingButtons | null | undefined;
  guesses: Guesses;
  labelId: string;
  stateId: string | undefined;
}) {
  const view = thingButtonView(toggle);
  const reasonId = useId();
  const next = switchValue(on);
  const busy = buttons?.running(toggle, next) || buttons?.running(toggle, !next) || false;
  const off = view.disabled || !buttons;
  const described = [stateId, view.reason ? reasonId : null].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <Toggle
        size="sm"
        checked={on}
        className={cx(styles.ctlSwitch, off && styles.ctlSwitchOff)}
        aria-labelledby={labelId}
        aria-describedby={described}
        aria-disabled={off || undefined}
        aria-busy={busy || undefined}
        title={view.reason ?? undefined}
        onCheckedChange={() => {
          if (off || busy || !buttons) return;
          buttons.press(toggle, {
            value: next,
            onSend: () => guesses.guess(control.id, next),
            onDone: (r) => {
              if (r.sent) guesses.done(control.id, r);
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

function ControlStepper({
  control,
  stepper,
  buttons,
  guesses,
}: {
  control: ThingControl;
  stepper: ThingControlStepper;
  buttons: ThingButtons | null | undefined;
  guesses: Guesses;
}) {
  const view = thingButtonView(stepper.button);
  const reasonId = useId();
  const value = guessedStep({ id: control.id, stepper }, guesses.guesses as ControlGuesses);
  const draft = useStepperDraft(value, stepper, (v) =>
    buttons?.press(stepper.button, {
      value: v,
      onSend: () => guesses.guess(control.id, v),
      onDone: (r) => {
        if (r.sent) guesses.done(control.id, r);
      },
    }),
  );
  const off = view.disabled || !buttons;
  const busy = buttons?.running(stepper.button, draft.shown) ?? false;
  const step = (dir: 1 | -1) => {
    if (!off && stepperCan(stepper, draft.shown, dir)) draft.step(dir);
  };
  const described = view.reason ? reasonId : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a figure between two buttons, not a fieldset of inputs
    <div className={styles.stepper} role="group" aria-label={control.label} aria-busy={busy || undefined}>
      <button
        type="button"
        className={styles.stepBtn}
        aria-label={`Lower ${control.label}`}
        aria-disabled={off || !stepperCan(stepper, draft.shown, -1) || undefined}
        aria-describedby={described}
        title={view.reason ?? undefined}
        onClick={() => step(-1)}
      >
        <Icon icon={Minus} size={15} />
      </button>
      <output className={styles.stepValue} aria-live="polite">
        {stepperWords(stepper, draft.shown)}
      </output>
      <button
        type="button"
        className={styles.stepBtn}
        aria-label={`Raise ${control.label}`}
        aria-disabled={off || !stepperCan(stepper, draft.shown, 1) || undefined}
        aria-describedby={described}
        title={view.reason ?? undefined}
        onClick={() => step(1)}
      >
        <Icon icon={Plus} size={15} />
      </button>
      {view.reason ? (
        <span id={reasonId} className={things.srOnly}>
          {view.reason}
        </span>
      ) : null}
    </div>
  );
}
