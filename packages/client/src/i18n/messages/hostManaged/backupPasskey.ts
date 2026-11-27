import { treeCatalogs } from '../../tree';

/** What a passkey touch for the backups says (`managed/kit-passkey.ts`). */
export const BACKUP_PASSKEY_WORDS = treeCatalogs(
  'hostManaged.backupPasskey',
  {
    upgradeAction: 'Finish setup',
    armed: 'Your passkey now unlocks your backups.',
    again: 'Your passkey is saved. Choose “Finish setup” to continue.',
    unsupported:
      'Your passkey provider didn’t return an encryption key. Update your browser and passkey provider, then try again. You can also save a paper copy of your backup details.',
    upgrade:
      'This older passkey signs you in but can’t unlock backups. Choose “Finish setup” to use one passkey for your account, Whombats and backups. An existing shared passkey will be reused.',
    saving: 'Your backup details are being saved. Touch your passkey again in a moment to verify them.',
    verify: 'Your backup key is saved. Touch your passkey once more to verify that it unlocks your backups.',
    failed: 'That didn’t work. Try again.',
    wrongKey:
      'This passkey didn’t unlock the saved backup details. Your current backup access has been kept.',
  },
  {
    upgradeAction: 'Instellen afronden',
    armed: 'Je passkey ontgrendelt nu je back-ups.',
    again: 'Je passkey is bewaard. Kies “Instellen afronden” om door te gaan.',
    unsupported:
      'Je passkeyprovider gaf geen versleutelingssleutel terug. Werk je browser en passkeyprovider bij en probeer het opnieuw. Je kunt ook een papieren kopie van je back-upgegevens bewaren.',
    upgrade:
      'Met deze oudere passkey log je in, maar hij kan geen back-ups ontgrendelen. Kies “Instellen afronden” om één passkey te gebruiken voor je account, Whombats en back-ups. Een bestaande gedeelde passkey wordt opnieuw gebruikt.',
    saving: 'Je back-upgegevens worden bewaard. Raak je passkey zo nog eens aan om ze te controleren.',
    verify:
      'Je back-upsleutel is bewaard. Raak je passkey nog één keer aan om te controleren of hij je back-ups ontgrendelt.',
    failed: 'Dat lukte niet. Probeer het opnieuw.',
    wrongKey:
      'Deze passkey ontgrendelde de bewaarde back-upgegevens niet. Je huidige toegang tot je back-ups is behouden.',
  },
);
