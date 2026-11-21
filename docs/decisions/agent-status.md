# Agent status

- **AS-01 The runtime keeps an agent's status honest around its turns.** Live agents set their status with
  `set_status` when they think of it and rarely clear it, so a finished agent could say “waiting” for hours.
  The runtime now commits `settle_agent_status` as the agent (a signed `agent.status`, like `set_status`):
  - a claimed turn makes the agent `working` (nothing is written when it already is);
  - a turn that ended (done, cancelled, or failed for good; not a crash that will be retried) moves `working`
    to `idle`, unless another of the agent's turns is still claimed or running;
  - `waiting` survives the end of a turn only when the agent set it during that turn, because the start of the
    turn replaced any older one. The persona and the `set_status` description tell agents to set `waiting`
    (and what they wait for) when they end a turn blocked on a person.
  - The RIGHT NOW line is the agent's last one (the mock's idle agents show what they last did); a personal
    agent's stays the fixed words of IN-17 (“Working for Mara.”, “Ready when Mara is.”).
  - Settling never holds up a turn: a failure is logged and the turn goes on.
- **AS-02 Waiting means blocked, not parked.** Told “Nothing for now”, an agent set `waiting` for an item it
  had parked (“ping me whenever”). The persona and the `set_status` description now say: waiting only when work
  it was asked to do cannot go on until someone else acts (an approval, a key, a fix, an answer to its
  question); something parked or offered for later leaves the status alone, so the turn ends idle. The mock
  agrees: Hazel waits for Banjo’s fix, Dusty for a person to say yes to the deploy.
- **AS-03 Waiting means an unanswered question, and the status is Whombat's** (replaces the agent-set
  `waiting` of AS-01 and AS-02; the person: “waiting should only appear when the agent has a question that
  needs to be answered”).
  - `post_message`, `reply_in_thread` and `post_card` take `asks: true` for a message that asks a person
    something the agent needs answered; it is stored on the message (`messages.asks`, agents only).
  - A question is open until a person posts after it in its place (the same thread, or top level) or in its
    own thread. Another agent's message is no answer.
  - The status is settled, never taken from the agent: `working` while one of its turns is claimed or running,
    else `waiting` while it has an open question, else `idle`. `set_status` takes only the RIGHT NOW line
    (`{ doing }`; an old `status` is ignored) and writes the settled status with it.
  - Settled when a turn is claimed, when it ends, when the agent calls `set_status`, and after a person posts
    in a conversation where an agent member shows `waiting` (a post-commit `settle_agent_status` as that
    agent, since an answer in a channel does not wake it). Seeded `waiting` rows with no question behind
    them settle to `idle` the same way.
  - Approvals and key requests are not questions here: they have their own cards and inbox.
