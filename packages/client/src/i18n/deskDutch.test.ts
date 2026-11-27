import { describe, expect, it } from 'vitest';
import { DESK_TEXT, deskQuietText, deskScreenLine, deskText, deskUnlockAnswerText } from '../desk/model';
import { pageHoursText, pageShowSaid } from '../desk/pageTimes';
import {
  DESK_SCREENS_TEXT,
  deskScreensText,
  pagesText,
  refusalText,
  screensErrorText,
} from '../desk/screens';
import { workingLabel } from '../working';

describe('the desk screen in Dutch', () => {
  it('speaks Dutch in the SCREEN section and its dialogs', () => {
    const nl = deskText('nl');
    expect(nl.section).toBe('SCHERM');
    expect(nl.unpairedTitle).toContain('niet gekoppeld');
    expect(nl.pairedYou('20 okt')).toContain('jou');
    expect(nl.offDialog.lead(true)).toContain('pincode');
    expect(nl.unlock.meta(90)).toContain('2 min');
    expect(nl.dialog.changesIn(3)).toContain('3 min');
    expect(deskQuietText({ enabled: true, start: '22:00', end: '07:00' }, 'black', 'nl')).toContain('zwart');
    expect(deskScreenLine({ connected: false, real: true, builtIn: false, name: null }, 'nl')).toContain(
      'geen scherm',
    );
    expect(deskUnlockAnswerText(true, undefined, 'nl')).toContain('ontgrendeld');
  });

  it('keeps English as it was when no locale is given', () => {
    expect(deskText().unpairDialog).toEqual(DESK_TEXT.unpairDialog);
    expect(deskText().pairedYou('20 Oct')).toBe(DESK_TEXT.pairedYou('20 Oct'));
    expect(deskText('en').section).toBe('SCREEN');
    expect(deskScreensText().editor.shapes).toEqual(DESK_SCREENS_TEXT.editor.shapes);
  });

  it('speaks Dutch in Settings → Screens and the editor', () => {
    const nl = deskScreensText('nl');
    expect(nl.title).toBe('Schermen');
    expect(nl.editor.shapes.tall).toBe('Hoog');
    expect(nl.editor.shapes.normal).toBe('Normaal');
    expect(pagesText(3, 'nl')).toBe('3 pagina’s');
    expect(refusalText('tooBig', { w: 2, h: 1 }, false, 'nl')).toContain('2 × 1');
    expect(screensErrorText(new Error('x'), undefined, 'nl')).toContain('Probeer het opnieuw');
    expect(screensErrorText(new Error('x'))).toBe('That didn’t work. Try again.');
  });

  it('says page times in Dutch', () => {
    expect(pageHoursText({ from: '07:00', to: '07:00' }, 'nl')).toBe(
      deskScreensText('nl').editor.times.allDay,
    );
    expect(pageShowSaid('Ochtend', null, 'nl')).toContain('Ochtend');
    expect(pageShowSaid('Ochtend', null, 'nl')).toContain('altijd');
  });

  it('says who is thinking in Dutch', () => {
    const at = 1_000_000;
    const label = workingLabel('Banjo', null, at, 'nl');
    expect(label).toContain('Banjo');
    expect(label).not.toContain('is thinking');
  });
});
