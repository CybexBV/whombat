import type { OperationName } from '../operations.js';
import type { AssistantSetting } from './types.js';
import { ask, change, guarded, NONE, never, read } from './types.js';

/** The person's own places: profile, devices, notifications, the assistant, memory, skills, connections, Vault, GitHub. */
export const PEOPLE_SETTINGS = {
  // The assistant: its keys and allowances stay the person's. A model change can cost money, so it asks.
  'agent.commandAllowances': read('advanced.keys', 'Read the commands that are always allowed'),
  'agent.get': read('agent.profile', 'Read the assistant’s name, face, model and keys'),
  'agent.removeCommandAllowance': never('advanced.keys', 'Make an always-allowed command ask again'),
  'agent.setKeys': never('agent.may', 'Change what the assistant may do'),
  'agent.update': ask('agent.profile', 'Change the assistant’s name, face or model'),

  // Approvals are decided by the person; the lists are work, not settings.
  'approvals.decide': never('agent.may', 'Approve or decline what is waiting for your yes'),
  'approvals.get': NONE,
  'approvals.list': NONE,
  'approvals.undo': never('agent.may', 'Undo an approval decision'),

  'clients.install': ask('advanced.ai', 'Install an AI program on this Whombat'),
  'clients.list': read('advanced.ai', 'Read which AI programs are installed'),
  'clients.remove': ask('advanced.ai', 'Remove an AI program from this Whombat'),

  // The websites the assistant keeps signed in between chats (Whombat kept-sites.md): it keeps and forgets them with
  // its own browser tools; stopping one from Settings asks.
  'keptSites.list': read('agent.may', 'Read the websites kept signed in between chats and until when'),
  'keptSites.stop': ask('agent.may', 'Stop keeping a website signed in'),

  // Connections: sign-in flows and secrets stay with the person; tool tiers widen what the assistant may do, so they ask.
  'connections.allowNetwork': never('advanced.network', 'Add a network to the home network list'),
  'connections.catalog': read('connections', 'Read which services can be connected'),
  'connections.check': change('connections', 'Check a connection again'),
  'connections.create': never('connections', 'Connect a service with a token'),
  'connections.disconnect': ask('connections', 'Remove a connection and its tools'),
  'connections.discover': change('overview', 'Look for services on the home network'),
  // A Find My timeline is the person's: the assistant reads it through its own tool (findmy_timeline), when allowed.
  'connections.findMyTimeline': NONE,
  'connections.findMyTimelineDelete': NONE,
  'connections.findMyTimelineMap': NONE,
  'connections.findMyTimelineSet': NONE,
  // The assistant starts and stops its watches through its own tool (findmy_watch).
  'connections.findMyWatchCancel': NONE,
  // The 1Password sync is the person's, like the Vault's secrets: the assistant neither reads it nor runs it.
  'connections.onePassword': NONE,
  'connections.onePasswordRemovals': NONE,
  'connections.onePasswordSync': NONE,
  'connections.finishGoogle': NONE,
  'connections.finishMicrosoft': NONE,
  'connections.finishOAuth': NONE,
  'connections.hideFound': change('overview', 'Hide a found service or show it again'),
  'connections.identify': NONE,
  'connections.list': read('connections', 'Read the connected accounts and services'),
  'connections.pollNextcloud': NONE,
  'connections.pollServiceLogin': NONE,
  'connections.probe': NONE,
  'connections.recheck': change('connections', 'Check a connection again and read its tools'),
  'connections.remove': ask('connections', 'Disconnect an account and forget it'),
  'connections.setRunsOn': change('overview', 'Say which server a service runs on'),
  'connections.setSecret': never('connections', 'Replace the token of a connection'),
  'connections.setTool': never('agent.may', 'Set a connection tool to Allowed, Asks or Off'),
  'connections.setToolLimits': never('agent.may', 'Set limits on what a connection tool may do'),
  'connections.startGoogle': NONE,
  'connections.startMicrosoft': NONE,
  'connections.startNextcloud': NONE,
  'connections.startOAuth': NONE,
  'connections.startServiceLogin': NONE,
  'connections.tools': read('connections', 'Read the tools of a connection and their settings'),
  // Its address and access level stay the person's: the stored password or token is sent to a new address to check it,
  // and Manage lifts Look only, what the assistant may do with the service.
  'connections.update': guarded(change('connections', 'Rename a connection'), {
    'body.fields': 'never',
    'body.access': 'never',
  }),

  'connectors.imapConnect': never('connections', 'Connect a mailbox over IMAP'),
  'connectors.imapDiscover': NONE,
  'connectors.removeApp': ask('connections', 'Remove the app a service signs in with'),
  'connectors.removeGoogleApp': ask('connections', 'Remove the Google app and disconnect Google'),
  'connectors.removeMicrosoftApp': ask('connections', 'Remove the Microsoft app and disconnect Microsoft'),
  'connectors.setApp': never('connections', 'Save the app a service signs in with'),
  'connectors.setGoogleApp': never('connections', 'Save the Google app'),
  'connectors.setMicrosoftApp': never('connections', 'Save the Microsoft app'),
  'connectors.status': read('connections', 'Read which Google and Microsoft apps are set up'),

  // Devices and push: the person's own phones and computers. Push handles are plumbing.
  'devices.register': NONE,
  'devices.registerLiveActivity': NONE,
  'devices.remove': never('you.devices', 'Stop sending pushes to a device'),
  'devices.reportErrors': NONE,
  'devices.update': NONE,
  'devices.vapidKey': NONE,

  'endpoints.list': never('you.devices', 'See the devices signed in to this Whombat'),
  'endpoints.rename': never('you.devices', 'Rename a signed-in device'),
  'endpoints.revoke': never('you.devices', 'Sign a device out of this Whombat'),

  // Enrolling a device is a flow the person does on the device.
  'enroll.claim': NONE,
  'enroll.claim.begin': NONE,
  'enroll.claim.local': NONE,
  'enroll.claim.local.begin': NONE,
  'enroll.claim.local.prove': NONE,
  'enroll.claim.local.start': NONE,
  'enroll.dev': NONE,
  'enroll.display.request': NONE,
  'enroll.display.status': NONE,
  'enroll.link.accept': NONE,
  'enroll.link.create': NONE,
  'enroll.pair.approve': NONE,
  'enroll.pair.lookup': NONE,
  'enroll.pair.request': NONE,
  'enroll.pair.status': NONE,
  'enroll.passkey': NONE,
  'enroll.screen': NONE,
  'enroll.screen.begin': NONE,
  'enroll.screen.request': NONE,

  'github.avatar': NONE,
  'github.connect': ask('advanced.github', 'Connect GitHub with your sign-in'),
  'github.repos': read('advanced.github', 'Read the GitHub repositories you can reach'),
  'github.status': read('advanced.github', 'Read whether GitHub is connected'),

  'guides.act': NONE,

  'me.get': read('you.profile', 'Read your name, title and settings'),
  'me.getPreferences': read('you.profile', 'Read your theme and time zone'),
  'me.setAvatar': change('you.profile', 'Set or remove your photo'),
  'me.updatePreferences': change('you.profile', 'Change your theme or time zone'),
  'me.updateProfile': change('you.profile', 'Change your name and title'),

  // Looks ahead (looks-ahead.md): what the assistant checks ahead is the person's to switch, as they ask.
  'looksAhead.get': read(
    'agent.ahead',
    'Read what Looks ahead checks and keeps an eye on, its rules and recent checks',
  ),
  'looksAhead.update': change(
    'agent.ahead',
    'Change Looks ahead switches, calendars, rules or what it keeps an eye on',
  ),
  'looksAhead.checkNow': change('agent.ahead', 'Check upcoming plans and incoming mail now'),
  // Acting on a finding in the person's Inbox is the person's own, never an assistant setting.
  'looksAhead.promote': NONE,
  'looksAhead.feedback': NONE,

  // Replacing the notes or a memory file loses the old text, so it asks.
  'memory.clear': never('agent.memory', 'Make the assistant forget what it remembers about you'),
  'memory.mine': read('agent.memory', 'Read what the assistant remembers about you'),
  'memory.notes': read('agent.memory', 'Read the notes the assistant reads in every chat'),
  'memory.setNotes': ask('agent.memory', 'Replace the notes the assistant reads in every chat'),
  'memory.write': ask('agent.memory', 'Replace what the assistant remembers about you'),

  // Feeds of activity, not settings.
  'notifications.inbox': NONE,
  'notifications.markRead': NONE,

  'onboarding.complete': NONE,
  'onboarding.get': NONE,
  'onboarding.update': NONE,

  // Box passkeys (4.3): the person's own, like the hosted ones.
  'boxPasskey.enroll': NONE,
  'boxPasskey.enroll.begin': NONE,
  'boxPasskey.failed': NONE,
  'boxPasskey.register': never('you.devices', 'Add a passkey for this Whombat’s own address'),
  'boxPasskey.register.begin': NONE,

  'passkey.register': never('you.devices', 'Add a passkey'),
  'passkey.register.begin': NONE,
  'passkey.link': never('you.devices', 'Use a shared passkey'),
  'passkey.remove': never('you.devices', 'Remove a passkey'),
  'passkeys.list': never('you.devices', 'See your passkeys'),
  'passkeys.policy': never('you.devices', 'Change when a passkey is needed'),

  'push.handles.clear': NONE,
  'push.handles.set': NONE,
  'push.token.clear': NONE,
  'push.token.set': NONE,
  'push.resolve': NONE,

  'recovery.enroll': NONE,
  'recovery.kit.confirm': never('you.devices', 'Confirm the recovery kit is saved'),
  'recovery.kit.register': never('you.devices', 'Save a recovery kit'),
  'recovery.kit.rotate': never('you.devices', 'Make a new recovery kit'),

  // Older apps' repository switch: every repository is the assistant's, so there is nothing left to change.
  'repos.add': change('advanced.github', 'Add a GitHub repository'),
  'repos.create': change('advanced.github', 'Create a Git repository on this Whombat'),
  'repos.list': read('advanced.github', 'Read the repositories the assistant works in'),
  'repos.sync': change('advanced.github', 'Bring in the repositories from GitHub again'),
  'repos.update': NONE,

  // Signing in to Claude or ChatGPT happens in the page, with the person's own account.
  'signins.consoleCancel': NONE,
  'signins.consoleRead': NONE,
  'signins.consoleResize': NONE,
  'signins.consoleStart': NONE,
  'signins.consoleWrite': NONE,
  'signins.list': never('agent.ai', 'See your Claude and ChatGPT sign-ins'),
  'signins.loginCancel': NONE,
  'signins.loginStart': NONE,
  'signins.loginStatus': NONE,
  'signins.loginSubmit': NONE,
  'signins.logout': never('agent.ai', 'Sign out of Claude or ChatGPT'),

  // Installing or editing a skill changes what the assistant does, and a hub skill is someone else's code: those ask.
  'skills.hubInstall': ask('advanced.skills', 'Install a skill from the hub'),
  'skills.hubPreview': read('advanced.skills', 'Read a hub skill before installing it'),
  'skills.hubSearch': read('advanced.skills', 'Search the hub for skills'),
  'skills.hubUpdate': ask('advanced.skills', 'Update a skill from the hub'),
  'skills.hubUpdates': read('advanced.skills', 'Read which hub skills have a newer version'),
  'skills.library': read('advanced.skills', 'Read the assistant’s skills'),
  'skills.libraryEdit': ask('advanced.skills', 'Change the text of a skill'),
  'skills.libraryRemove': ask('advanced.skills', 'Remove a skill'),
  'skills.libraryRestore': ask('advanced.skills', 'Bring back the original version of a skill'),
  'skills.librarySkill': read('advanced.skills', 'Read one skill'),
  'skills.librarySkillFile': read('advanced.skills', 'Read one file of a skill'),
  'skills.librarySwitch': change('advanced.skills', 'Turn a skill on or off'),

  'spend.daily': read('advanced.spend', 'Read what the AI used each day'),
  'spend.overview': read('advanced.spend', 'Read what the AI used and cost'),
  'spend.week': read('advanced.spend', 'Read what the assistant did this week'),

  'usage.list': read('agent.ai', 'Read how much of your Claude and ChatGPT plans is used'),
  'usage.refresh': change('agent.ai', 'Check how much of a Claude or ChatGPT plan is used now'),

  // The Vault stays the person's: its entries, secrets, keys and servers.
  'vault.addSshServer': never('vault', 'Add a server to a Vault key'),
  'vault.check': never('vault', 'Check a Vault connection'),
  'vault.checkSshServer': never('vault', 'Check a server in the Vault'),
  'vault.create': never('vault', 'Add an entry to the Vault'),
  'vault.generateSshKey': never('vault', 'Make a new key for a Vault server'),
  'vault.get': never('vault', 'See one Vault entry'),
  'vault.giveKey': never('vault', 'Let the assistant use a Vault entry'),
  'vault.list': never('vault', 'See your Vault entries'),
  'vault.remove': never('vault', 'Remove an entry from the Vault'),
  'vault.removeSshServer': never('vault', 'Remove a server from a Vault key'),
  'vault.replaceSshKey': never('vault', 'Replace a Vault key with your own'),
  'vault.setKeyEnvName': never('vault', 'Change the name a Vault value has in commands'),
  'vault.setKeyServers': never('vault', 'Choose which servers a Vault key covers'),
  'vault.setSecret': never('vault', 'Replace the secret of a Vault entry'),
  'vault.setTool': never('vault', 'Turn a tool of a Vault entry on or off'),
  'vault.setTotp': never('vault', 'Set or remove the authenticator key of a login'),
  'vault.takeKey': never('vault', 'Stop the assistant using a Vault entry'),
  'vault.trustSshHostKey': never('vault', 'Trust a server’s key in the Vault'),
  'vault.update': never('vault', 'Change a Vault entry’s name or address'),
  'vault.updateSshServer': never('vault', 'Change a server in the Vault'),
  'vault.uses': never('vault', 'See when a Vault entry was used'),

  'vaultNetworks.add': never('advanced.network', 'Add a network to the Vault’s home network list'),
  'vaultNetworks.list': never('advanced.network', 'See the Vault’s home network list'),
  'vaultNetworks.remove': never('advanced.network', 'Remove a network from the Vault’s home network list'),
} as const satisfies Partial<Record<OperationName, AssistantSetting>>;
