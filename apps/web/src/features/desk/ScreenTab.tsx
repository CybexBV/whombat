/**
 * Settings → Screen: the box's own screen as a desk display, in a tab of its own on a Whombat with a screen. On top
 * the switch *Show Whombat on this screen* with the screen line (and *Pair the screen* while nobody is paired); once
 * paired, four parts (`&part=`): *What it shows* (the preview and the choices, `ShowsPart`, where the runtime lists
 * them), *Lock and PIN*, *Night* and *Talk* (`DeskRows.tsx`). Opening it gives the box the Whombat's name when it has
 * another (`useDeskNameSync`).
 */

import { agentFaceOf } from '@whombat/client';
import {
  DESK_WORDS,
  type DeskApi,
  type DeskScreen,
  deskSectionView,
  fillDeskWords,
} from '@whombat/client/desk';
import { useDesk, useDeskClock } from '@whombat/client/desk/react';
import { useTheAgent } from '@whombat/client/react';
import { formatDate } from '@whombat/core/text';
import { useState } from 'react';
import { cx } from '../../components/cx';
import { SegmentedControl } from '../../components/SegmentedControl';
import { currentLocale } from '../../i18n/provider';
import styles from '../settings/SettingsScreen.module.css';
import {
  ChoiceSwitchRow,
  LockAgainRow,
  LockedRow,
  OffDialog,
  PairDialog,
  PinDialog,
  PinRow,
  QuietRows,
  SwitchRow,
  TalkRow,
  UnpairedRow,
  VoiceRow,
} from './DeskRows';
import s from './Screen.module.css';
import { ShowsPart, TopBarPart } from './ShowsPart';
import { type ScreenPart, screenPartOpen, screenParts } from './screenTab';
import { useDeskHere } from './useDeskHere';
import { useDeskNameSync } from './useDeskNameSync';

const W = DESK_WORDS.settings;

export interface ScreenTabProps {
  burrow: string;
  /** The part that is open (`&part=`); the first that shows without. */
  part?: ScreenPart;
  onPartChange?: (part: ScreenPart) => void;
  /**
   * The box's own page in Settings → Screens (3.6): *Top bar* in *What it shows*' place, the middle and the strip
   * being widgets now.
   */
  widgets?: boolean;
}

export function ScreenTab({ burrow, part, onPartChange, widgets = false }: ScreenTabProps) {
  const here = useDeskHere(burrow);
  const desk = useDesk(here.api);
  useDeskNameSync(burrow);
  if (!here.api || !desk.data) return null;
  return (
    <Screen
      burrow={burrow}
      api={here.api}
      timeZone={here.timeZone}
      screen={desk.data}
      part={part}
      onPartChange={onPartChange}
      widgets={widgets}
    />
  );
}

type Dialog = 'pair' | 'pin' | 'off' | null;

function Screen({
  burrow,
  api,
  timeZone,
  screen,
  part,
  onPartChange,
  widgets,
}: {
  burrow: string;
  api: DeskApi;
  timeZone: string;
  screen: DeskScreen;
  part: ScreenPart | undefined;
  onPartChange: ((part: ScreenPart) => void) | undefined;
  widgets: boolean;
}) {
  const { agent, words } = useTheAgent(burrow);
  const assistant = words.name;
  const [dialog, setDialog] = useState<Dialog>(null);
  // Without a place in the address (a test, a story) the parts switch here.
  const [own, setOwn] = useState<ScreenPart | undefined>(undefined);
  // The pairing line under “The screen isn’t paired” goes by the clock.
  const now = useDeskClock(Boolean(screen.pairing), 15_000);
  const v = deskSectionView(screen, { assistant, timeZone, now, locale: currentLocale() });
  const parts = screenParts(screen, widgets);
  const open = screenPartOpen(parts, onPartChange ? part : own);
  const line = screen.paired
    ? fillDeskWords(W.pairedLine, {
        name: v.onScreen.line,
        date: formatDate(screen.paired.pairedAt, timeZone, { year: 'auto', now }, currentLocale()),
      })
    : v.onScreen.line;
  const close = () => setDialog(null);
  return (
    <div className={s.tab} data-screen-tab="">
      <div className={cx(styles.card, s.card)}>
        <SwitchRow
          api={api}
          view={v.onScreen}
          line={line}
          paired={screen.paired !== null}
          onAskOff={() => setDialog('off')}
        />
        {v.unpaired ? <UnpairedRow unpaired={v.unpaired} onPair={() => setDialog('pair')} /> : null}
      </div>
      {open && v.mine ? (
        <>
          <SegmentedControl
            variant="soft"
            label={W.openScreen}
            className={s.parts}
            value={open}
            onChange={(next) => (onPartChange ? onPartChange(next) : setOwn(next))}
            options={parts.map((p) => ({ value: p, label: p === 'bar' ? W.bar : W.parts[p] }))}
          />
          <div className={s.partBody} data-screen-part={open}>
            {open === 'bar' ? (
              <TopBarPart api={api} screen={screen} assistant={assistant} />
            ) : open === 'shows' ? (
              <ShowsPart
                api={api}
                screen={screen}
                assistant={assistant}
                face={agentFaceOf(agent)}
                timeZone={timeZone}
              />
            ) : open === 'lock' ? (
              <div className={cx(styles.card, s.card)}>
                <PinRow pin={v.mine.pin} onChangePin={() => setDialog('pin')} />
                <LockedRow api={api} mine={v.mine} />
                {v.lockAgain ? <LockAgainRow api={api} view={v.lockAgain} /> : null}
              </div>
            ) : open === 'night' ? (
              <div className={cx(styles.card, s.card)}>
                <QuietRows api={api} mine={v.mine} timeZone={timeZone} />
                {v.cameraWake ? (
                  <ChoiceSwitchRow
                    api={api}
                    row="desk-camera"
                    view={v.cameraWake}
                    patch={(cameraWake) => ({ cameraWake })}
                  />
                ) : null}
              </div>
            ) : (
              <div className={cx(styles.card, s.card)}>
                <TalkRow api={api} talk={v.mine.talk} />
                {v.mine.voice ? <VoiceRow api={api} view={v.mine.voice} assistant={assistant} /> : null}
              </div>
            )}
          </div>
        </>
      ) : null}
      <PairDialog open={dialog === 'pair'} onClose={close} api={api} />
      <PinDialog open={dialog === 'pin'} onClose={close} api={api} first={v.mine?.pin.has === false} />
      <OffDialog
        open={dialog === 'off'}
        onClose={close}
        api={api}
        paired={v.paired !== null}
        hasPin={screen.paired?.hasPin !== false}
      />
    </div>
  );
}
