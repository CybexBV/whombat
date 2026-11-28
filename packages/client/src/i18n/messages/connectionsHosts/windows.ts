import { treeCatalogs } from '../../tree';

/** A Windows PC's page (`hosts/windows.ts`). */
export const HOSTS_WINDOWS_WORDS = treeCatalogs(
  'hostsWindows',
  {
    thisPc: 'This PC',
    facts: {
      model: 'Model',
      protection: 'Virus protection',
      definitions: 'Virus definitions',
      quickScan: 'Last quick scan',
      updatesChecked: 'Windows Update looked',
      updatesInstalled: 'Last updates installed',
      bitlocker: 'BitLocker',
    },
    values: {
      on: 'On',
      off: 'Off',
      notKnown: 'Not known',
      productOn: '{product} is on',
      drive: '{drive} {state}',
      driveOn: 'on',
      driveOff: 'off',
      driveUnknown: 'not known',
    },
    updatesNote:
      'Whombat doesn’t install Windows updates. Install them on the PC in Settings → Windows Update.',
  },
  {
    thisPc: 'Deze pc',
    facts: {
      model: 'Model',
      protection: 'Virusbescherming',
      definitions: 'Virusdefinities',
      quickScan: 'Laatste snelle scan',
      updatesChecked: 'Windows Update keek',
      updatesInstalled: 'Laatste updates geïnstalleerd',
      bitlocker: 'BitLocker',
    },
    values: {
      on: 'Aan',
      off: 'Uit',
      notKnown: 'Niet bekend',
      productOn: '{product} staat aan',
      drive: '{drive} {state}',
      driveOn: 'aan',
      driveOff: 'uit',
      driveUnknown: 'niet bekend',
    },
    updatesNote:
      'Whombat installeert geen Windows-updates. Installeer ze op de pc via Instellingen → Windows Update.',
  },
);
