# Final Chat · four platforms and read states

This is **Chat’s chronological message timeline**, under the scoring row name `chat-list`. It is not step 02’s replacement thread list. Shared navigation: [SHELL.md](../SHELL.md); every pictured fact: [STORY.md](../STORY.md); overall source ledger, contrast method and limitations: [final NOTES](../NOTES.md).

## Fix by app

Desktop keeps UIR-64’s separate **Waiting for you / Answer**, UIR-65’s answer destination and UIR-66’s full-row reply navigation. Phone web uses the same timeline and waiting treatment, with one **44×44 ⋯ per message on its author line**. Native keeps AP-7417’s **3 replies · Waiting for you** joined row, long-press/word selection/custom accessibility actions, without adding ⋯ that would increase the 24pt ordinary author line. Android targets are ≥48dp. All four omit the person’s name and face on their own message headers; the timestamp remains.

Search, Files, Vault and Usage follow the one shell. Places is a labelled navigation control; More in Chat is a separate room-actions control. Feedback and Settled retain fit priority. The single File destination leaves Chat’s header/room overflow as required by this round’s consolidation. Desktop Settings is explicitly named in navigation; the person’s footer is not another hidden home.

## Stage and unread

The stage selector reads only the real thread flags: **Waiting for you > {assistant} is working > Handed over > Settled**. Marks are respectively an amber dot, incomplete neutral ring, branch arrow and neutral tick. No flag is not Settled. Zero replies says **No replies yet**; other unflagged roots show real reply count/time. Firmware has no replies and a true working flag, so it explicitly says **{assistant} is working**. The heat-pump and memory roots wait. The whole row links; no repeated “Open thread ›” appears, but the accessible name still explains its destination.

Web waiting words stay in the existing chip immediately above the reply link, once; the reply link’s accessible name includes them. Native waiting words live inside the link. The assistant’s participant face is the only eligible face in this one-person thread. Native self messages retain the combined accessibility element and hidden selectable duplicate on implementation; the HTML is a geometry/action proxy, not an OS accessibility replacement.

**Unread is independent.** The selected normal Chat roots have no supplied per-root unread evidence; do not fake a dot from their reply counts. The fixture’s **one unread Feedback thread** supplies Chat’s tab/sidebar badge 1 and the Feedback action’s 1. TU-05’s per-root brand dot and screen-reader “New replies” apply only when that query proves a matching root, suppressed for the open thread and Settled. This preserves TU-05 without inventing a new reply in the picture.

UIR-64/66, AP-7417, AP-2454, TU-05 and AP-2408 remain in force. The separate thread-list surface still updates its cache in newest-activity order; it does not reorder Chat root messages. No alternative list is offered here. Settle remains conditional: waiting, working and handed-over roots cannot settle. Four actual settled objects supply the shelf; a “Done” sentence alone never qualifies. The static Settle action is a destination preview; implementation retains confirmations, original 8s Undo and focus return. No approval recommendation/consequence/undo is invented.

## Read states and pictures

For each `desktop`, `phoneweb`, `ios`, `android` in light/dark:

| Picture suffix / scenario | Visible words and behavior |
| --- | --- |
| `<platform>-<theme>.png` | Normal saved timeline, same 14:05 story. Arrival anchors to the heat-pump root, leaving older messages above. |
| `-loading-` | **Loading your Chat…**, one polite status and decorative skeletons. No fake waiting/zero/message content. |
| `-empty-` | Successful zero roots: **Your Chat starts here.** / **Ask {assistant} anything. Each question gets its own thread.** / **Ask a question**, which focuses the unsent composer. |
| `-failed-` | **Couldn’t read your Chat.** / **There’s no saved copy to show on this device yet.** / **Try again**, **Ask {assistant}**, folded **More detail**. |
| `-saved-failed-` | **Couldn’t refresh your Chat.** / **Showing the messages already on this device.** The timeline stays underneath in its original order. |

The block matches step 05: local warn-text heading, `sf`, `line2`, no red health cue or additional failure banner. Try again repeats **messages.list only**; this static control announces Reading again without fabricating a response. Ask prepares an unsent help question and focuses it. Diagnostic “The fixture read did not answer.” is a seeded scenario, hidden until expanded. A read failure is not proof a command failed, and no command/action retry is offered.

The before pictures are fresh captures of **step 11’s HTML mockup**, not running-app/native screenshots. Both normal sides have exactly the same viewport and theme. Step 11 used different per-platform clocks/excerpts; the final uses one composed 14:05 story, so this is a design comparison, not a pixel-only diff. There is no matching committed before PNG for the new query-state scenes; the viewer says so, and links to step 11’s same-state HTML instead of showing a misleading normal image.

## Screen readers, focus, targets and expansion

Reading order: shared navigation → Chat heading → Feedback / Settled / More in Chat → day → message author/time/body → saved-as/subject when present → web waiting chip / Answer → reply link → next message → composer → native tabs. Self messages say **Your message** in the native combined name, followed by time and exact body. Reply link example: **“3 replies, Waiting for you, Why is pve-02 using so much memory?, Open thread.”** The subject names **pve-02, Running warm** from STORY. Decorative faces inside the link and marks do not repeat names. Colour never substitutes for a word.

Web ⋯ is named **Actions for your/{assistant}’s message at {time}**, with dialog/expanded state. Enter/Space opens the conditional action menu; the first available action takes focus. Native contextmenu / Shift+F10 in this HTML is a review proxy for existing long-press and accessibility actions, without overriding selected words. Reply, reaction, Edit/Delete for self, Pin and Copy link follow the existing contextual policy; Settle appears only on an eligible root. No action sends anything. Implementation must keep its existing confirmation/receipt behavior rather than treat a preview as success.

The modal contains focus; Close/Escape/scrim returns to the original ⋯ or combined native message at the same scroll position. Nested preview explanations keep the original opener. More detail expands directly below its summary and keeps trigger focus, with wrapped diagnostics. Feedback/Settled/More in Chat are distinct labelled dialogs in this static review; the real navigation stacks and Undo remain implementation requirements. Answer goes to the existing waiting card, not an answer submission; the thread/approval final screen is supplied by the next part.

Phone web and iOS targets are ≥44, Android ≥48, including textarea, buttons, full reply links and disclosures. Desktop reply links retain 40px. No element is visually reordered by a timer. Largest text uses **200% web** / **kept 1.6× native**, with readable wrapped question/stage/error words, stacked composer controls and scrollable history. Settled moves into More in Chat when enlarged; the native tab fitting exception remains. No raised native cap is implied. Largest captures are local evidence; actual OS text, keyboard, safe areas and VoiceOver/TalkBack remain gaps.

## Source and contrast record

`story.js` uses `agentWords(assistantAgent().name).name`; message text/times/subject/saved record and flags are direct fixture reads. The shell owns badges independently of root flags. Every source family is mapped in final NOTES and every conflicting numeric/status choice in STORY. There is no invented “failed thread” state, timestamp or current memory reading in a message from an earlier time.

WCAG solid text/background minima across drawn states, light / dark: desktop **4.942 / 5.515**, phone web **5.190 / 5.515**, iOS **5.281 / 5.515**, Android **5.281 / 5.515**. Decorative badge/control foreground pairs are recorded separately in `../renders.json`; the sampled badge/control minimum is **4.888 light / 5.515 dark**, meeting 4.5:1. Provider/avatar artwork, scrimmed background content and native rasterization are outside this nominal-HTML measure. Rendering and colour observations only; no lint, typecheck, notices, tests, CI or PR-check wait under John’s explicit NO CI instruction.
