# This Whombat (the box)

## Settings → This Whombat → Overview (`appliance.overview`)

How the box is doing, its network and Wi-Fi, Tailscale, Bluetooth, voice typing and mail.

- Read how this Whombat is doing — `appliance.status` · read
- Read this Whombat’s name and time zone — `burrows.get` · read
- Rename this Whombat, set its time zone or link previews — `burrows.update` · change
- Read whether the assistant can reply — `host.agents` · read
- Read the box’s Bluetooth and its devices — `host.bluetooth` · read
- Cancel pairing a Bluetooth device — `host.bluetooth.cancel` · change
- Confirm the code when pairing Bluetooth — `host.bluetooth.confirm` · theirs: send them there
- Connect a Bluetooth device — `host.bluetooth.connect` · change
- Disconnect a Bluetooth device — `host.bluetooth.disconnect` · change, always asks
- Forget a Bluetooth device — `host.bluetooth.forget` · change, always asks
- Start pairing a Bluetooth device — `host.bluetooth.pair` · change
- Look for Bluetooth devices nearby — `host.bluetooth.scan` · read
- Use Wi-Fi only or the cable again — `host.cable.set` · change, always asks
- Read the box’s hardware — `host.hardware` · read
- Read whether services can run on the box — `host.info` · read
- Read the mail server Whombat sends through — `host.mail` · read
- Stop using your mail server — `host.mail.remove` · theirs: send them there
- Set your mail server (it needs a password) — `host.mail.set` · theirs: send them there
- Test your mail server (it needs a password) — `host.mail.test` · theirs: send them there
- Read how busy the box is — `host.metrics` · read
- Read how the box connects to the network — `host.network` · read
- Check again whether the assistant can reply — `host.recheckAgents` · change
- Read whether Tailscale is on — `host.tailscale` · read
- Turn Tailscale off — `host.tailscale.off` · change, always asks
- Turn Tailscale on — `host.tailscale.on` · change, always asks
- Sign the box in to Tailscale — `host.tailscale.signIn` · change, always asks
- Forget a Wi-Fi network — `host.wifi.forget` · change, always asks
- Join a Wi-Fi network (it needs a password) — `host.wifi.join` · theirs: send them there
- Look for Wi-Fi networks nearby — `host.wifi.scan` · read
- Download the voice typing model — `voice.fetchModel` · change
- Read the voice typing settings — `voice.get` · read
- Delete the voice typing model — `voice.removeModel` · change, always asks
- Turn the Dutch voice on or off (you must agree to its licence yourself) — `voice.setDutchVoice` · theirs: send them there
- Change the voice typing settings — `voice.update` · change

## Settings → This Whombat → Backups (`appliance.backups`)

Where the box backs up, when, and backup files.

- Join an earlier Whombat’s backups to bring it back — `backup.adopt` · theirs: send them there
- Check that a backup restores — `backup.check` · change
- Read the list of backups — `backup.checkpoints` · read
- Set where the box backs up (it needs a password) — `backup.configureDestination` · theirs: send them there
- Look for an earlier Whombat’s locked backup details on the network — `backup.findKits` · read
- Finish bringing a Whombat back — `backup.finishRestore` · theirs: send them there
- Forget a place that keeps the backups — `backup.forgetPlace` · change, always asks
- Say yes to backups at the claim — `backup.letAssistantSetUp` · theirs: send them there
- Open a backup to look inside it — `backup.look` · read
- Bring things back from a backup — `backup.lookBring` · change, always asks
- Close a backup that was opened to look inside it — `backup.lookClose` · change
- Read what is in a backup that is open — `backup.lookContents` · read
- Move the backups left on this Whombat to the backup place — `backup.moveLocal` · change, always asks
- Read the backups, the places and the options — `backup.overview` · read
- Note that the paper copy of the backup details was saved — `backup.paperCopy.confirm` · theirs: send them there
- Stop a passkey from opening the backups — `backup.passkeyKey.remove` · theirs: send them there
- Use a passkey to open the backups — `backup.passkeyKey.set` · theirs: send them there
- Verify a passkey opens the backups — `backup.passkeyKey.verifyBegin` · theirs: send them there
- Confirm a passkey opens the backups — `backup.passkeyKey.verifyConfirm` · theirs: send them there
- Set up a backup place by hand — `backup.placeByHand` · theirs: send them there
- Check that a backup place works — `backup.placeCheck` · change
- Read the places that can keep the backups — `backup.places` · read
- Read how often backups run and how long they are kept — `backup.policy` · read
- Show the recovery details for the backups — `backup.recoveryMaterial` · theirs: send them there
- Remove the backups left on this Whombat — `backup.removeLocal` · change, always asks
- Bring a Whombat back from a backup — `backup.restore` · theirs: send them there
- Read how bringing a Whombat back is going — `backup.restoreState` · read
- Back up now — `backup.runNow` · change
- Change how often backups run and how long they are kept — `backup.setPolicy` · change, always asks
- Read the key a backup place needs to trust — `backup.sshPublicKey` · read
- Read how the backups are doing — `backup.status` · read
- Back up to a different place — `backup.usePlace` · change, always asks
- Make a backup file — `backups.create` · theirs: send them there
- Read what a new backup file includes — `backups.defaults` · read
- Read how big a backup file would be — `backups.estimate` · read
- Read one backup file — `backups.get` · read
- Read how a restore is going — `backups.getRestore` · read
- Look inside a backup file — `backups.inspect` · theirs: send them there
- Read the backup files — `backups.list` · read
- Delete a backup file — `backups.remove` · change, always asks
- Restore a backup file — `backups.restore` · theirs: send them there
- Choose what a new backup file includes — `backups.setDefaults` · change

## Settings → This Whombat → Screen (`appliance.screen`)

The box’s screen and other screens: what they show, the lock, night and Talk.

- Answer a request to unlock the screen — `desk.answerUnlock` · theirs: send them there
- Read how the box’s screen is set up — `desk.get` · read
- Pair a screen (it needs a code) — `desk.pair` · theirs: send them there
- Preview what the screen will show — `desk.preview` · read
- Add a screen (it needs a code) — `desk.screen.add` · theirs: send them there
- Read one screen and what it shows — `desk.screen.get` · read
- Remove a screen — `desk.screen.remove` · change, always asks
- Try a layout on a screen — `desk.screen.try` · change
- Change what a screen shows — `desk.screen.update` · change
- Read the views a screen can show — `desk.screen.views` · read
- Read the screens and what they show — `desk.screens` · read
- Rename the box’s screen — `desk.setName` · change
- Set the screen’s PIN — `desk.setPin` · theirs: send them there
- Switch the box’s screen on or off — `desk.setScreen` · change, always asks
- Try a layout on the box’s screen — `desk.tryOnScreen` · change
- Disconnect the box’s screen — `desk.unpair` · change, always asks
- Change what the box’s screen shows and when it rests — `desk.update` · change
- Read the widgets a screen can show — `desk.widgets` · read

## Settings → This Whombat → About (`appliance.about`)

Versions and updates, when updates may happen, remote help and the licence.

- Link this Whombat to your account — `account.link` · theirs: send them there
- Look up whose account a link code is — `account.link.lookup` · theirs: send them there
- Turn “Ask before updating” on or off — `appliance.update.ask` · theirs: send them there
- Install an update that waits for the owner — `appliance.update.install` · theirs: send them there
- Read the quiet hours for updates and restarts — `changeWindow.get` · read
- Change the quiet hours for updates and restarts — `changeWindow.set` · change, always asks
- Check the licence again — `licence.refresh` · theirs: send them there
- Read the licence — `licence.status` · theirs: send them there
- Turn Whombat Link off — `link.off` · theirs: send them there
- Turn Whombat Link on — `link.on` · theirs: send them there
- Read which other Whombats share this Whombat Link account — `link.whombats` · read
- Check whether a name is free for this Whombat’s address — `ownAddress.check` · read
- Turn reaching this Whombat’s page from anywhere on or off — `ownAddress.reach.set` · theirs: send them there
- Change this Whombat’s address — `ownAddress.rename` · change, always asks
- Read this Whombat’s own address and its certificate — `ownAddress.status` · read
- Read how this Whombat is reached: Whombat Link, its address and Tailscale — `reach.get` · read
- Confirm that support may connect — `remoteHelp.confirmBegin` · theirs: send them there
- Read whether remote help is on — `remoteHelp.get` · theirs: send them there
- Turn remote help on — `remoteHelp.start` · theirs: send them there
- Turn remote help off — `remoteHelp.stop` · theirs: send them there
- Download what support did — `remoteHelp.transcript` · theirs: send them there
- Read the support visits — `remoteHelp.visits` · theirs: send them there
- Read which updates this Whombat takes — `updates.channel.get` · read
- Choose Production or Development updates — `updates.channel.set` · theirs: send them there
