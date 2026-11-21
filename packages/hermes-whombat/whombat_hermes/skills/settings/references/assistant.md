# You, the assistant

## Settings → (your name) → Name and face (`agent.profile`)

(your name)’s name, face and voice.

- Read the assistant’s name, face, model and keys — `agent.get` · read
- Change the assistant’s name, face or model — `agent.update` · change, always asks

## Settings → (your name) → AI sign-in (`agent.ai`)

What (your name) runs on, and your Claude and ChatGPT sign-ins.

- Read which AI answers in Chat and which models are ready — `chats.runtime` · read
- Choose which AI answers in a chat thread — `chats.setThreadRuntime` · change, always asks
- See your Claude and ChatGPT sign-ins — `signins.list` · theirs: send them there
- Sign out of Claude or ChatGPT — `signins.logout` · theirs: send them there
- Read how much of your Claude and ChatGPT plans is used — `usage.list` · read
- Check how much of a Claude or ChatGPT plan is used now — `usage.refresh` · change

## Settings → (your name) → Memory (`agent.memory`)

What (your name) remembers about you, and the notes it reads in every chat.

- Make the assistant forget what it remembers about you — `memory.clear` · theirs: send them there
- Read what the assistant remembers about you — `memory.mine` · read
- Read the notes the assistant reads in every chat — `memory.notes` · read
- Replace the notes the assistant reads in every chat — `memory.setNotes` · change, always asks
- Replace what the assistant remembers about you — `memory.write` · change, always asks

## Settings → (your name) → What (your name) may do (`agent.may`)

Every permission: servers, connections, the Vault, the local network and the risky keys.

- Change what the assistant may do — `agent.setKeys` · theirs: send them there
- Approve or decline what is waiting for your yes — `approvals.decide` · theirs: send them there
- Undo an approval decision — `approvals.undo` · theirs: send them there
- Set a connection tool to Allowed, Asks or Off — `connections.setTool` · theirs: send them there
- Set limits on what a connection tool may do — `connections.setToolLimits` · theirs: send them there
- Read the websites kept signed in between chats and until when — `keptSites.list` · read
- Stop keeping a website signed in — `keptSites.stop` · change, always asks

## Settings → (your name) → Council (`agent.council`)

The councils (your name) can ask: which AIs sit on each, with which model and effort, and the default.

- Go back to Whombat’s own choice for the council — `councils.resetSetup` · change, always asks
- Change the council: its AIs, models, effort and score — `councils.saveSetup` · change
- Read the council: who sits on it, with which model and effort — `councils.setup` · read
