# Vault, Automations and Inbox

## Vault (`vault`)

What (your name) can sign in to: passwords, keys and servers.

- Add a server to a Vault key — `vault.addSshServer` · theirs: send them there
- Check a Vault connection — `vault.check` · theirs: send them there
- Check a server in the Vault — `vault.checkSshServer` · theirs: send them there
- Add an entry to the Vault — `vault.create` · theirs: send them there
- Make a new key for a Vault server — `vault.generateSshKey` · theirs: send them there
- See one Vault entry — `vault.get` · theirs: send them there
- Let the assistant use a Vault entry — `vault.giveKey` · theirs: send them there
- See your Vault entries — `vault.list` · theirs: send them there
- Remove an entry from the Vault — `vault.remove` · theirs: send them there
- Remove a server from a Vault key — `vault.removeSshServer` · theirs: send them there
- Replace a Vault key with your own — `vault.replaceSshKey` · theirs: send them there
- Change the name a Vault value has in commands — `vault.setKeyEnvName` · theirs: send them there
- Choose which servers a Vault key covers — `vault.setKeyServers` · theirs: send them there
- Replace the secret of a Vault entry — `vault.setSecret` · theirs: send them there
- Turn a tool of a Vault entry on or off — `vault.setTool` · theirs: send them there
- Set or remove the authenticator key of a login — `vault.setTotp` · theirs: send them there
- Stop the assistant using a Vault entry — `vault.takeKey` · theirs: send them there
- Trust a server’s key in the Vault — `vault.trustSshHostKey` · theirs: send them there
- Change a Vault entry’s name or address — `vault.update` · theirs: send them there
- Change a server in the Vault — `vault.updateSshServer` · theirs: send them there
- See when a Vault entry was used — `vault.uses` · theirs: send them there

## Automations (`automations`)

The automations, their runs, and switching them on and off.

- Delete an automation — `automations.delete` · change, always asks
- Read an automation and how it is set up — `automations.get` · read
- Read the automations and whether each is on — `automations.list` · read
- Turn an automation on or off — `automations.setEnabled` · change
- Choose what an automation may do — `automations.setKeys` · theirs: send them there
- Turn an automation’s web address on or off — `automations.webhook` · theirs: send them there
