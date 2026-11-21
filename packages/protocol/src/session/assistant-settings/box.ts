/**
 * The box's own settings (docs/decisions/assistant-settings.md): This Whombat's health, network, backups, screens,
 * voice typing, licence, remote help, diagnostics, and the services and widgets on the Overview.
 */
import type { OperationName } from '../operations.js';
import type { AssistantSetting } from './types.js';
import { ask, change, NONE, never, read } from './types.js';

export const BOX_SETTINGS = {
  'appliance.status': read('appliance.overview', 'Read how this Whombat is doing'),
  // The own address (4.3): who reaches the box's page, and which account the box belongs to, are the owner's alone.
  'ownAddress.status': read('appliance.about', 'Read this Whombat’s own address and its certificate'),
  'ownAddress.reach.set': never(
    'appliance.about',
    'Turn reaching this Whombat’s page from anywhere on or off',
  ),
  'account.link.lookup': never('appliance.about', 'Look up whose account a link code is'),
  'account.link': never('appliance.about', 'Link this Whombat to your account'),
  // Reach and Updates (4.4): how the box is reached and where its updates come from are the owner's; the assistant may
  // say how the box is reached.
  'reach.get': read(
    'appliance.about',
    'Read how this Whombat is reached: Whombat Link, its address and Tailscale',
  ),
  'link.on': never('appliance.about', 'Turn Whombat Link on'),
  'link.off': never('appliance.about', 'Turn Whombat Link off'),
  'updates.channel.get': read('appliance.about', 'Read which updates this Whombat takes'),
  'updates.channel.set': never('appliance.about', 'Choose Production or Development updates'),
  // Whether updates wait for the owner, and the owner's yes to one: theirs alone, so nobody acting for them turns it off.
  'appliance.update.ask': never('appliance.about', 'Turn “Ask before updating” on or off'),
  'appliance.update.install': never('appliance.about', 'Install an update that waits for the owner'),

  'audit.export': never('advanced.audit', 'Export the signed audit log'),
  'audit.get': read('advanced.audit', 'Read one entry of the audit log'),
  'audit.list': read('advanced.audit', 'Read the audit log'),
  'audit.verify': read('advanced.audit', 'Check that the audit log is intact'),

  'backup.adopt': never('appliance.backups', 'Join an earlier Whombat’s backups to bring it back'),
  'backup.configureDestination': never(
    'appliance.backups',
    'Set where the box backs up (it needs a password)',
  ),
  'backup.forgetPlace': ask('appliance.backups', 'Forget a place that keeps the backups'),
  'backup.check': change('appliance.backups', 'Check that a backup restores'),
  'backup.checkpoints': read('appliance.backups', 'Read the list of backups'),
  'backup.finishRestore': never('appliance.backups', 'Finish bringing a Whombat back'),
  // The person's own yes at the claim: the assistant acts on it, it never gives it.
  'backup.letAssistantSetUp': never('appliance.backups', 'Say yes to backups at the claim'),
  'backup.overview': read('appliance.backups', 'Read the backups, the places and the options'),
  // Only finds the earlier Whombat's locked backup details next to its backups; nothing opens them without a passkey.
  'backup.findKits': read(
    'appliance.backups',
    'Look for an earlier Whombat’s locked backup details on the network',
  ),
  // Getting one thing back (backup-look.md): looking is a read; bringing back only adds, and always asks first.
  'backup.look': read('appliance.backups', 'Open a backup to look inside it'),
  'backup.lookBring': ask('appliance.backups', 'Bring things back from a backup'),
  'backup.lookClose': change('appliance.backups', 'Close a backup that was opened to look inside it'),
  'backup.lookContents': read('appliance.backups', 'Read what is in a backup that is open'),
  'backup.moveLocal': ask('appliance.backups', 'Move the backups left on this Whombat to the backup place'),
  'backup.policy': read('appliance.backups', 'Read how often backups run and how long they are kept'),
  'backup.removeLocal': ask('appliance.backups', 'Remove the backups left on this Whombat'),
  'backup.restore': never('appliance.backups', 'Bring a Whombat back from a backup'),
  'backup.restoreState': read('appliance.backups', 'Read how bringing a Whombat back is going'),
  'backup.setPolicy': ask('appliance.backups', 'Change how often backups run and how long they are kept'),
  // Its answer holds the line the person pastes into their NAS, so it stays on the page.
  'backup.placeByHand': never('appliance.backups', 'Set up a backup place by hand'),
  'backup.placeCheck': change('appliance.backups', 'Check that a backup place works'),
  'backup.places': read('appliance.backups', 'Read the places that can keep the backups'),
  // The passkey that locks the backups and the paper copy are the person's own, on their device.
  'backup.paperCopy.confirm': never(
    'appliance.backups',
    'Note that the paper copy of the backup details was saved',
  ),
  'backup.passkeyKey.remove': never('appliance.backups', 'Stop a passkey from opening the backups'),
  'backup.passkeyKey.verifyBegin': never('appliance.backups', 'Verify a passkey opens the backups'),
  'backup.passkeyKey.verifyConfirm': never('appliance.backups', 'Confirm a passkey opens the backups'),
  'backup.passkeyKey.set': never('appliance.backups', 'Use a passkey to open the backups'),
  'backup.recoveryMaterial': never('appliance.backups', 'Show the recovery details for the backups'),
  'backup.runNow': change('appliance.backups', 'Back up now'),
  'backup.sshPublicKey': read('appliance.backups', 'Read the key a backup place needs to trust'),
  'backup.status': read('appliance.backups', 'Read how the backups are doing'),
  'backup.usePlace': ask('appliance.backups', 'Back up to a different place'),

  'backups.create': never('appliance.backups', 'Make a backup file'),
  'backups.defaults': read('appliance.backups', 'Read what a new backup file includes'),
  'backups.estimate': read('appliance.backups', 'Read how big a backup file would be'),
  'backups.get': read('appliance.backups', 'Read one backup file'),
  'backups.getRestore': read('appliance.backups', 'Read how a restore is going'),
  'backups.getUpload': NONE,
  'backups.inspect': never('appliance.backups', 'Look inside a backup file'),
  'backups.list': read('appliance.backups', 'Read the backup files'),
  'backups.remove': ask('appliance.backups', 'Delete a backup file'),
  'backups.removeUpload': NONE,
  'backups.restore': never('appliance.backups', 'Restore a backup file'),
  'backups.setDefaults': change('appliance.backups', 'Choose what a new backup file includes'),
  'backups.stage': NONE,

  'burrows.clearLocalModel': ask('advanced.ai', 'Remove the custom AI model'),
  'burrows.clearWebSearch': ask('advanced.ai', 'Turn off web search'),
  'burrows.create': NONE,
  'burrows.get': read('appliance.overview', 'Read this Whombat’s name and time zone'),
  'burrows.setAgentsReachLan': never(
    'advanced.network',
    'Let the assistant’s commands reach your local network, or not',
  ),
  'burrows.setAiGateway': ask('advanced.ai', 'Send the AI through the AI gateway, or stop'),
  'burrows.setLocalModel': never(
    'advanced.ai',
    'Set a custom AI model (https service or network server; may need a key)',
  ),
  // The person pastes the key there themselves: the assistant points them to the page.
  'burrows.setWebSearch': never('advanced.ai', 'Turn on web search with a Brave Search key'),
  'burrows.slugCheck': NONE,
  'burrows.testLocalModel': never('advanced.ai', 'Test the custom AI model'),
  'burrows.testWebSearch': change('advanced.ai', 'Check the web search key again'),
  'burrows.update': change('appliance.overview', 'Rename this Whombat, set its time zone or link previews'),

  'changeWindow.get': read('appliance.about', 'Read the quiet hours for updates and restarts'),
  'changeWindow.set': ask('appliance.about', 'Change the quiet hours for updates and restarts'),

  // Someone at the screen asks to unlock it: only the person answers that.
  'desk.answerUnlock': never('appliance.screen', 'Answer a request to unlock the screen'),
  'desk.get': read('appliance.screen', 'Read how the box’s screen is set up'),
  'desk.pair': never('appliance.screen', 'Pair a screen (it needs a code)'),
  'desk.preview': read('appliance.screen', 'Preview what the screen will show'),
  'desk.screen.add': never('appliance.screen', 'Add a screen (it needs a code)'),
  'desk.screen.get': read('appliance.screen', 'Read one screen and what it shows'),
  'desk.screen.remove': ask('appliance.screen', 'Remove a screen'),
  'desk.screen.try': change('appliance.screen', 'Try a layout on a screen'),
  'desk.screen.update': change('appliance.screen', 'Change what a screen shows'),
  'desk.screen.views': read('appliance.screen', 'Read the views a screen can show'),
  'desk.screens': read('appliance.screen', 'Read the screens and what they show'),
  'desk.setName': change('appliance.screen', 'Rename the box’s screen'),
  'desk.setPin': never('appliance.screen', 'Set the screen’s PIN'),
  'desk.setScreen': ask('appliance.screen', 'Switch the box’s screen on or off'),
  'desk.startPairing': NONE,
  'desk.tryOnScreen': change('appliance.screen', 'Try a layout on the box’s screen'),
  'desk.unpair': ask('appliance.screen', 'Disconnect the box’s screen'),
  'desk.update': change('appliance.screen', 'Change what the box’s screen shows and when it rests'),
  // Only as an export stream (a sound file): nothing the assistant reads.
  'desk.voiceSample': NONE,
  'desk.widgets': read('appliance.screen', 'Read the widgets a screen can show'),

  'diagnostics.create': change('advanced.diagnostics', 'Make a diagnostic bundle for support'),
  'diagnostics.delete': ask('advanced.diagnostics', 'Delete a diagnostic bundle'),
  'diagnostics.download': never('advanced.diagnostics', 'Download a diagnostic bundle'),
  'diagnostics.list': read('advanced.diagnostics', 'Read the diagnostic bundles'),
  'diagnostics.preview': read('advanced.diagnostics', 'Read what a diagnostic bundle holds'),

  // The manager's, through the admin socket; never over a session.
  'health.get': NONE,

  'host.agents': read('appliance.overview', 'Read whether the assistant can reply'),
  'host.bluetooth': read('appliance.overview', 'Read the box’s Bluetooth and its devices'),
  'host.bluetooth.cancel': change('appliance.overview', 'Cancel pairing a Bluetooth device'),
  // The person checks the code on the device, so only they confirm.
  'host.bluetooth.confirm': never('appliance.overview', 'Confirm the code when pairing Bluetooth'),
  'host.bluetooth.connect': change('appliance.overview', 'Connect a Bluetooth device'),
  'host.bluetooth.disconnect': ask('appliance.overview', 'Disconnect a Bluetooth device'),
  'host.bluetooth.forget': ask('appliance.overview', 'Forget a Bluetooth device'),
  'host.bluetooth.pair': change('appliance.overview', 'Start pairing a Bluetooth device'),
  'host.bluetooth.scan': read('appliance.overview', 'Look for Bluetooth devices nearby'),
  'host.cable.set': ask('appliance.overview', 'Use Wi-Fi only or the cable again'),
  'host.hardware': read('appliance.overview', 'Read the box’s hardware'),
  'host.info': read('appliance.overview', 'Read whether services can run on the box'),
  'host.mail': read('appliance.overview', 'Read the mail server Whombat sends through'),
  // The box's own mail server is set with its password on the page: removing it stays there too.
  'host.mail.remove': never('appliance.overview', 'Stop using your mail server'),
  'host.mail.set': never('appliance.overview', 'Set your mail server (it needs a password)'),
  'host.mail.test': never('appliance.overview', 'Test your mail server (it needs a password)'),
  'host.metrics': read('appliance.overview', 'Read how busy the box is'),
  'host.network': read('appliance.overview', 'Read how the box connects to the network'),
  'host.recheckAgents': change('appliance.overview', 'Check again whether the assistant can reply'),
  'host.tailscale': read('appliance.overview', 'Read whether Tailscale is on'),
  'host.tailscale.off': ask('appliance.overview', 'Turn Tailscale off'),
  'host.tailscale.on': ask('appliance.overview', 'Turn Tailscale on'),
  'host.tailscale.signIn': ask('appliance.overview', 'Sign the box in to Tailscale'),
  'host.wifi.forget': ask('appliance.overview', 'Forget a Wi-Fi network'),
  'host.wifi.join': never('appliance.overview', 'Join a Wi-Fi network (it needs a password)'),
  'host.wifi.scan': read('appliance.overview', 'Look for Wi-Fi networks nearby'),

  'licence.refresh': never('appliance.about', 'Check the licence again'),
  'licence.status': never('appliance.about', 'Read the licence'),

  'remoteHelp.confirmBegin': never('appliance.about', 'Confirm that support may connect'),
  'remoteHelp.get': never('appliance.about', 'Read whether remote help is on'),
  'remoteHelp.start': never('appliance.about', 'Turn remote help on'),
  'remoteHelp.stop': never('appliance.about', 'Turn remote help off'),
  'remoteHelp.transcript': never('appliance.about', 'Download what support did'),
  'remoteHelp.visits': never('appliance.about', 'Read the support visits'),

  // A screen elsewhere has its own session; the assistant never speaks for it.
  'screen.image': NONE,
  'screen.lock': NONE,
  'screen.state': NONE,
  'screen.unlock': NONE,

  'services.list': read('overview', 'Read what the assistant runs on the box'),
  'services.stop': ask('overview', 'Stop a service the assistant runs'),

  'voice.fetchModel': change('appliance.overview', 'Download the voice typing model'),
  'voice.get': read('appliance.overview', 'Read the voice typing settings'),
  'voice.removeModel': ask('appliance.overview', 'Delete the voice typing model'),
  'voice.update': change('appliance.overview', 'Change the voice typing settings'),

  'widgets.list': read('overview', 'Read the widgets on the Overview'),
  'widgets.move': change('overview', 'Move a widget on the Overview'),
  'widgets.remove': ask('overview', 'Remove a widget from the Overview'),
} as const satisfies Partial<Record<OperationName, AssistantSetting>>;
