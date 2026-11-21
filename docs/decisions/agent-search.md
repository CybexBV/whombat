# Agent search and the web key

Direct instruction (2026-09-25): an agent without “Search messages, canvases and runs” couldn't search at all,
not even the channels it works in, and “Browse the web” could not be given to an agent from the UI.

| # | Decision | Why |
|---|----------|-----|
| ASR-01 | **Superseded in part by one-person.md OP-S71**: the person's turn searches every room the agent is in, with no audience or asker limit, and an outsiders' turn searches nothing. **Every agent searches the conversations it is in; the key widens it.** The `search` MCP tool (`agent_search`) needs no key (`requiredKey: null`): without `messages.search` it reaches the agent's conversations, with it at `can` every channel and branch room too (`visibleConversations`, unchanged). Both stay within the dispatch's audience (BP-C31) and an answer's asker. With no key check there is no Asks / Blocked row for a search any more, so a personal agent's query never reaches the log (IN-18 holds trivially). `post_answer` (answering from the search screen) still needs the key. | Searching what the agent can already read with `read_conversation` gives nothing away; the key's own description (“including channels the agent is not in”) is what it guards. |
| ASR-02 | **“Browse the web” is a row in the hire modal and Configure**, off by default, after “Open pull requests”. The mock's `HIRE_KEYS` has no such row; the visual comparison hides it. It stays off by default and is not added to any role but the researcher: the key opens the agent's sandbox to the network, and with read access to repos, channels or an inbox that is the exfiltration path for a prompt-injected page. | Configure lists the same rows as the hire modal, so the key could not be given to any agent from the UI. |
