# Advanced

## Settings → Advanced → AI on this Whombat (`advanced.ai`)

The AI programs, the AI gateway, a custom AI model (an OpenAI-compatible service over https like OpenRouter or Google Gemini, or a model server on your network) and web search (a Brave Search key).

- Remove the custom AI model — `burrows.clearLocalModel` · change, always asks
- Turn off web search — `burrows.clearWebSearch` · change, always asks
- Send the AI through the AI gateway, or stop — `burrows.setAiGateway` · change, always asks
- Set a custom AI model (OpenAI-compatible internet service over https or a server on your network; may need a key) — `burrows.setLocalModel` · theirs: send them there
- Turn on web search with a Brave Search key — `burrows.setWebSearch` · theirs: send them there
- Test the custom AI model — `burrows.testLocalModel` · theirs: send them there
- Check the web search key again — `burrows.testWebSearch` · change
- Install an AI program on this Whombat — `clients.install` · change, always asks
- Read which AI programs are installed — `clients.list` · read
- Remove an AI program from this Whombat — `clients.remove` · change, always asks

## Settings → Advanced → Spend (`advanced.spend`)

What the AI costs, by day and week.

- Read what the AI used each day — `spend.daily` · read
- Read what the AI used and cost — `spend.overview` · read
- Read what the assistant did this week — `spend.week` · read

## Settings → (your name) → What (your name) may do → Keys (`advanced.keys`)

Every key (your name) holds and, folded under them, the commands it may always run.

- Read the commands that are always allowed — `agent.commandAllowances` · read
- Make an always-allowed command ask again — `agent.removeCommandAllowance` · theirs: send them there

## Settings → (your name) → What (your name) may do → Local network (`advanced.network`)

Whether (your name) reaches your local network and, while it doesn’t, which home networks it may.

- Let the assistant’s commands reach your local network, or not — `burrows.setAgentsReachLan` · theirs: send them there
- Add a network to the home network list — `connections.allowNetwork` · theirs: send them there
- Add a network to the Vault’s home network list — `vaultNetworks.add` · theirs: send them there
- See the Vault’s home network list — `vaultNetworks.list` · theirs: send them there
- Remove a network from the Vault’s home network list — `vaultNetworks.remove` · theirs: send them there

## Automations (`advanced.schedules`)

What (your name) does on a schedule, under Only tells you.

- Read what the assistant does on a schedule — `schedules.list` · read
- Pause a schedule — `schedules.pause` · change
- End a schedule for good — `schedules.remove` · change, always asks
- Resume a paused schedule — `schedules.resume` · change

## Settings → Advanced → Skills (`advanced.skills`)

(your name)’s skills: on and off, and more from the hub.

- Install a skill from the hub — `skills.hubInstall` · change, always asks
- Read a hub skill before installing it — `skills.hubPreview` · read
- Search the hub for skills — `skills.hubSearch` · read
- Update a skill from the hub — `skills.hubUpdate` · change, always asks
- Read which hub skills have a newer version — `skills.hubUpdates` · read
- Read the assistant’s skills — `skills.library` · read
- Change the text of a skill — `skills.libraryEdit` · change, always asks
- Remove a skill — `skills.libraryRemove` · change, always asks
- Bring back the original version of a skill — `skills.libraryRestore` · change, always asks
- Read one skill — `skills.librarySkill` · read
- Read one file of a skill — `skills.librarySkillFile` · read
- Turn a skill on or off — `skills.librarySwitch` · change

## Settings → Connections → GitHub (`advanced.github`)

GitHub and the repositories (your name) works in.

- Connect GitHub with your sign-in — `github.connect` · change, always asks
- Read the GitHub repositories you can reach — `github.repos` · read
- Read whether GitHub is connected — `github.status` · read
- Add a GitHub repository — `repos.add` · change
- Create a Git repository on this Whombat — `repos.create` · change
- Read the repositories the assistant works in — `repos.list` · read
- Bring in the repositories from GitHub again — `repos.sync` · change

## Settings → Connections → Website feedback (`advanced.feedback`)

Websites that send feedback to this Whombat.

- Add a website that sends feedback — `feedback.createIntegration` · change
- Read a website’s feedback setup — `feedback.getIntegration` · read
- Read the websites that send feedback — `feedback.listIntegrations` · read
- Pause or resume assessing feedback automatically — `feedback.setAssessment` · change
- Turn feedback intake on or off — `feedback.setIntake` · change
- Change a website’s feedback setup — `feedback.updateIntegration` · change

## Settings → Advanced → Audit log and signing keys (`advanced.audit`)

The signed log of everything done here.

- Export the signed audit log — `audit.export` · theirs: send them there
- Read one entry of the audit log — `audit.get` · read
- Read the audit log — `audit.list` · read
- Check that the audit log is intact — `audit.verify` · read

## Settings → Advanced → Diagnostics (`advanced.diagnostics`)

Diagnostic bundles for support.

- Make a diagnostic bundle for support — `diagnostics.create` · change
- Delete a diagnostic bundle — `diagnostics.delete` · change, always asks
- Download a diagnostic bundle — `diagnostics.download` · theirs: send them there
- Read the diagnostic bundles — `diagnostics.list` · read
- Read what a diagnostic bundle holds — `diagnostics.preview` · read
