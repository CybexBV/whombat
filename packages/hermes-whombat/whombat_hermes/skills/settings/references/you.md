# You

## Settings → You → Profile (`you.profile`)

Your name, title and photo, and how Chat settles finished threads.

- Read your name, title and settings — `me.get` · read
- Read your theme and time zone — `me.getPreferences` · read
- Set or remove your photo — `me.setAvatar` · change
- Change your theme or time zone — `me.updatePreferences` · change
- Change your name and title — `me.updateProfile` · change

## Settings → You → Notifications (`you.notifications`)

What Whombat tells you about, by push and by email.

- Choose how a conversation notifies you — `conversations.setNotify` · change
- Choose which emails Whombat Link sends you — `link.mail.set` · change, always asks

## Settings → You → Devices (`you.devices`)

The phones and computers signed in, and your passkeys.

- Add a passkey for this Whombat’s own address — `boxPasskey.register` · theirs: send them there
- Stop sending pushes to a device — `devices.remove` · theirs: send them there
- See the devices signed in to this Whombat — `endpoints.list` · theirs: send them there
- Rename a signed-in device — `endpoints.rename` · theirs: send them there
- Sign a device out of this Whombat — `endpoints.revoke` · theirs: send them there
- Use a shared passkey — `passkey.link` · theirs: send them there
- Add a passkey — `passkey.register` · theirs: send them there
- Remove a passkey — `passkey.remove` · theirs: send them there
- See your passkeys — `passkeys.list` · theirs: send them there
- Change when a passkey is needed — `passkeys.policy` · theirs: send them there
- Confirm the recovery kit is saved — `recovery.kit.confirm` · theirs: send them there
- Save a recovery kit — `recovery.kit.register` · theirs: send them there
- Make a new recovery kit — `recovery.kit.rotate` · theirs: send them there

## Settings → You → Prompts (`you.prompts`)

The prompts you keep to use again, offered after / in Chat.

- Keep words as a prompt, under a title — `prompts.create` · change
- Read your prompts: their titles, words and where each ran — `prompts.list` · read
- Remove a prompt — `prompts.remove` · change, always asks
- Bring back the prompts Whombat shipped, as shipped — `prompts.restore` · change, always asks
- Change a prompt: its title, words, whether it is for a repository, its AI — `prompts.save` · change
