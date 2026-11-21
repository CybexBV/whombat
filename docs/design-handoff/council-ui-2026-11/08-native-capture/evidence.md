# Native scoring evidence

Ten marks and ten evidence lines per screen/platform. Means exclude no scored point; Files is a GAP, never zero. Empty/loading/error marks remain capped at 6. These are reviewer assessments of the pictures and accessibility trees, not participant results or certification.

## Chat list

Waiting replies stay with each question; the latest-first viewport starts partway through older content.

### ios

[Light](png/ios-chat-list-light.png) · [Dark](png/ios-chat-list-dark.png) · [Accessibility tree](ios-chat-list-light.txt)

Mean 6.5 · 7/7/7/6/6/6/7/5/7/7

- **H** Chat’s title and composer frame a dense list.
- **C** The same memory question and waiting state appear on web.
- **F** Settled is visible normally and moves into More at large text.
- **G** Waiting is attached to the reply row; the card itself needs opening.
- **S** Only the loaded list was exercised.
- **D** Latest questions, composer and five tabs share 390 points.
- **T** Largest text wraps the composer; most text is capped at 1.6×.
- **K** iOS system badge: sampled red backgrounds limit white text to 3.570:1 light / 3.433:1 dark, below 4.5.
- **A** Messages are combined author/time/body elements with separate reply links. iOS AX snapshot inspected.
- **Q** Working and waiting stay separate, but multiple reply rows compete.

### android

[Light](png/android-chat-list-light.png) · [Dark](png/android-chat-list-dark.png) · [Accessibility tree](android-chat-list-light.txt)

Mean 6.7 · 7/7/7/6/6/6/7/8/6/7

- **H** Chat’s title and composer frame a dense list.
- **C** The same memory question and waiting state appear on web.
- **F** Settled is visible normally and moves into More at large text.
- **G** Waiting is attached to the reply row; the card itself needs opening.
- **S** Only the loaded list was exercised.
- **D** Latest questions, composer and five tabs share 390 points.
- **T** Largest text wraps the composer; most text is capped at 1.6×.
- **K** See measured pairs, including the platform tab badge.
- **A** Messages are combined author/time/body elements with separate reply links. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Working and waiting stay separate, but multiple reply rows compete.

## A thread with its cards

The memory question, replies and pending approval remain together; Review and answer opens the decision screen.

### ios

[Light](png/ios-thread-light.png) · [Dark](png/ios-thread-dark.png) · [Accessibility tree](ios-thread-light.txt)

Mean 7.4 · 8/7/7/8/6/7/8/8/7/8

- **H** The pending card stands out below the conversation.
- **C** Same ZFS story, with native fixture root msg_chat-memory.
- **F** Back returns to Chat; the subject opens pve-02.
- **G** One Review and answer door keeps decisions on their own screen.
- **S** The supplied web root shows a missing-conversation state; recovery states are incomplete.
- **D** Large text keeps the pending card and composer reachable by scrolling.
- **T** Text and the card wrap; the heading shortens after the root scrolls away.
- **K** Visible brand/background and muted/card pairs are measured.
- **A** The tree separates message cells, card and action; full screen-reader navigation is untested. iOS AX snapshot inspected.
- **Q** Only the waiting card asks for attention.

### android

[Light](png/android-thread-light.png) · [Dark](png/android-thread-dark.png) · [Accessibility tree](android-thread-light.txt)

Mean 7.3 · 8/7/7/8/6/7/8/8/6/8

- **H** The pending card stands out below the conversation.
- **C** Same ZFS story, with native fixture root msg_chat-memory.
- **F** Back returns to Chat; the subject opens pve-02.
- **G** One Review and answer door keeps decisions on their own screen.
- **S** The supplied web root shows a missing-conversation state; recovery states are incomplete.
- **D** Large text keeps the pending card and composer reachable by scrolling.
- **T** Text and the card wrap; the heading shortens after the root scrolls away.
- **K** Visible brand/background and muted/card pairs are measured.
- **A** The tree separates message cells, card and action; full screen-reader navigation is untested. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Only the waiting card asks for attention.

## An approval

One-time answers stay in the footer; the lasting yes sits apart and asks for confirmation. Native uses approval 33.

### ios

[Light](png/ios-approval-light.png) · [Dark](png/ios-approval-dark.png) · [Accessibility tree](ios-approval-light.txt)

Mean 7.5 · 8/7/8/8/6/7/8/8/7/8

- **H** Question, explanation and one-time answers have a clear order.
- **C** Same ZFS cache ask as web 902; native ID is 33.
- **F** Yes now, tonight and No are visible; details are folded.
- **G** The full question and consequence fit without tool syntax.
- **S** Requested 902 gives a missing-request state; failed reads and decided states are untested.
- **D** At largest text all three answers stack; content scrolls above them.
- **T** Question and labels wrap without shrinking.
- **K** Muted/background and back-label/background pairs are measured.
- **A** Named answers and details are present; no decision was submitted. iOS AX snapshot inspected.
- **Q** No answer is suggested; a lasting yes is separate.

### android

[Light](png/android-approval-light.png) · [Dark](png/android-approval-dark.png) · [Accessibility tree](android-approval-light.txt)

Mean 7.4 · 8/7/8/8/6/7/8/8/6/8

- **H** Question, explanation and one-time answers have a clear order.
- **C** Same ZFS cache ask as web 902; native ID is 33.
- **F** Yes now, tonight and No are visible; details are folded.
- **G** The full question and consequence fit without tool syntax.
- **S** Requested 902 gives a missing-request state; failed reads and decided states are untested.
- **D** At largest text all three answers stack; content scrolls above them.
- **T** Question and labels wrap without shrinking.
- **K** Muted/background and back-label/background pairs are measured.
- **A** Named answers and details are present; no decision was submitted. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** No answer is suggested; a lasting yes is separate.

## Inbox

blackbox comes first, followed by the restart and heat-pump choice; Settled stays at the bottom.

### ios

[Light](png/ios-inbox-light.png) · [Dark](png/ios-inbox-dark.png) · [Accessibility tree](ios-inbox-light.txt)

Mean 7.3 · 8/7/8/8/6/8/8/5/7/8

- **H** The failed disk array leads the list.
- **C** Same needs-person grouping, with the native fixture’s three rows.
- **F** Each row opens its own answer sheet; Settled is always visible.
- **G** Title, reason and time fit together.
- **S** Loaded list and empty Settled count only; error and empty-list journeys untested.
- **D** Rows leave room for their descriptions and the pinned Settled row.
- **T** Titles and descriptions remain distinct.
- **K** iOS system badge: sampled red backgrounds limit white text to 3.570:1 light / 3.433:1 dark, below 4.5.
- **A** Row names include their problem or choice; full reading order is not certified. iOS AX snapshot inspected.
- **Q** Only the broken disk-array tile is red.

### android

[Light](png/android-inbox-light.png) · [Dark](png/android-inbox-dark.png) · [Accessibility tree](android-inbox-light.txt)

Mean 7.5 · 8/7/8/8/6/8/8/8/6/8

- **H** The failed disk array leads the list.
- **C** Same needs-person grouping, with the native fixture’s three rows.
- **F** Each row opens its own answer sheet; Settled is always visible.
- **G** Title, reason and time fit together.
- **S** Loaded list and empty Settled count only; error and empty-list journeys untested.
- **D** Rows leave room for their descriptions and the pinned Settled row.
- **T** Titles and descriptions remain distinct.
- **K** Platform badge and muted card text are measured.
- **A** Row names include their problem or choice; full reading order is not certified. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Only the broken disk-array tile is red.

## Overview

Worst-first server cards identify blackbox; the figures still do not establish their sample time.

### ios

[Light](png/ios-overview-light.png) · [Dark](png/ios-overview-dark.png) · [Accessibility tree](ios-overview-light.txt)

Mean 6.5 · 7/7/8/7/5/6/7/5/7/6

- **H** The broken-server sentence and server cards lead.
- **C** Status words and neutral meters match the shipped web rules.
- **F** Server and Connections tabs are named and counted.
- **G** Name, health and figures are grouped; freshness is unclear.
- **S** Only successful fleet data was exercised.
- **D** Largest text uses two figure columns and scrollable tabs.
- **T** Figure labels are readable; tab labels are small and capped.
- **K** iOS system badge: sampled red backgrounds limit white text to 3.570:1 light / 3.433:1 dark, below 4.5.
- **A** Server names include health and figures in the tree; pull-to-refresh order is source-reviewed. iOS AX snapshot inspected.
- **Q** The sampled figures lack a last-checked time.

### android

[Light](png/android-overview-light.png) · [Dark](png/android-overview-dark.png) · [Accessibility tree](android-overview-light.txt)

Mean 6.7 · 7/7/8/7/5/6/7/8/6/6

- **H** The broken-server sentence and server cards lead.
- **C** Status words and neutral meters match the shipped web rules.
- **F** Server and Connections tabs are named and counted.
- **G** Name, health and figures are grouped; freshness is unclear.
- **S** Only successful fleet data was exercised.
- **D** Largest text uses two figure columns and scrollable tabs.
- **T** Figure labels are readable; tab labels are small and capped.
- **K** Bad/sf2, muted/sf2 and platform badges are measured.
- **A** Server names include health and figures in the tree; pull-to-refresh order is source-reviewed. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** The sampled figures lack a last-checked time.

## A connection page

Home Assistant shows status, host, address and folded detail above controls; the native connection is con_ha.

### ios

[Light](png/ios-connection-light.png) · [Dark](png/ios-connection-dark.png) · [Accessibility tree](ios-connection-light.txt)

Mean 6.6 · 7/7/7/7/5/6/7/6/7/7

- **H** Status, host and action precede Controls.
- **C** Same service, different fixture ID and controls data.
- **F** Ask, Open and More detail are named; lower notices need scrolling.
- **G** Control labels and state share each tile.
- **S** Wrong supplied ID has a recoverable settings link; live errors untested.
- **D** The controls grid pushes lower notices off the first viewport.
- **T** Control state lines use small muted text.
- **K** Lit-tile muted text measures 4.484:1 dark on iOS (below target) and 4.505:1 on Android.
- **A** iOS switches have names; Android’s tree also exposes duplicate unnamed switch nodes. iOS AX snapshot inspected.
- **Q** The status stays calm, but first-view freshness is not established.

### android

[Light](png/android-connection-light.png) · [Dark](png/android-connection-dark.png) · [Accessibility tree](android-connection-light.txt)

Mean 6.6 · 7/7/7/7/5/6/7/7/6/7

- **H** Status, host and action precede Controls.
- **C** Same service, different fixture ID and controls data.
- **F** Ask, Open and More detail are named; lower notices need scrolling.
- **G** Control labels and state share each tile.
- **S** Wrong supplied ID has a recoverable settings link; live errors untested.
- **D** The controls grid pushes lower notices off the first viewport.
- **T** Control state lines use small muted text.
- **K** Lit-tile muted text measures 4.484:1 dark on iOS (below target) and 4.505:1 on Android.
- **A** iOS switches have names; Android’s tree also exposes duplicate unnamed switch nodes. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** The status stays calm, but first-view freshness is not established.

## A server page

pve-02 groups plain-language figures, a warm-CPU notice and folded heads-ups; sample freshness remains limited.

### ios

[Light](png/ios-server-light.png) · [Dark](png/ios-server-dark.png) · [Accessibility tree](ios-server-light.txt)

Mean 6.8 · 7/7/7/7/5/7/7/7/7/7

- **H** Plain-language figures precede Worth a look.
- **C** Same server; native Summary and web Summary use their existing fixtures.
- **F** Summary, Machines and Backups are visible.
- **G** The warm notice explains its 40-minute observation.
- **S** Fleet/read failures and empty machines were not exercised.
- **D** Two figure columns fit 390 points.
- **T** Muted metadata and figure explanations stay readable.
- **K** Muted/background, muted/card and iOS back-brand pairs are measured.
- **A** Named figure and notice elements are present; full screen-reader path untested. iOS AX snapshot inspected.
- **Q** Heads-ups fold, while the page does not date its headline figures.

### android

[Light](png/android-server-light.png) · [Dark](png/android-server-dark.png) · [Accessibility tree](android-server-light.txt)

Mean 6.7 · 7/7/7/7/5/7/7/7/6/7

- **H** Plain-language figures precede Worth a look.
- **C** Same server; native Summary and web Summary use their existing fixtures.
- **F** Summary, Machines and Backups are visible.
- **G** The warm notice explains its 40-minute observation.
- **S** Fleet/read failures and empty machines were not exercised.
- **D** Two figure columns fit 390 points.
- **T** Muted metadata and figure explanations stay readable.
- **K** Muted/background, muted/card and iOS back-brand pairs are measured.
- **A** Named figure and notice elements are present; full screen-reader path untested. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Heads-ups fold, while the page does not date its headline figures.

## Automations

Three automation rows show trigger and latest outcome, with a waiting run kept in words; schedules follow.

### ios

[Light](png/ios-automations-light.png) · [Dark](png/ios-automations-dark.png) · [Accessibility tree](ios-automations-light.txt)

Mean 6.8 · 8/7/7/7/6/7/7/5/7/7

- **H** Tell field, automations and schedules have distinct groups.
- **C** The list uses native automation fixtures and shared run-bar words.
- **F** Rows open their automation; the latest run needs that extra step.
- **G** Trigger, state and last outcome stay together.
- **S** Loaded rows only; no failed-read or empty list was forced.
- **D** Names use up to two lines; schedules extend below the fold.
- **T** Small run metadata remains denser than the main label.
- **K** iOS system badge: sampled red backgrounds limit white text to 3.570:1 light / 3.433:1 dark, below 4.5.
- **A** Run bars have a spoken count and outcome summary. iOS AX snapshot inspected.
- **Q** On and waiting are distinct; no invented failed thread flag.

### android

[Light](png/android-automations-light.png) · [Dark](png/android-automations-dark.png) · [Accessibility tree](android-automations-light.txt)

Mean 6.9 · 8/7/7/7/6/7/7/7/6/7

- **H** Tell field, automations and schedules have distinct groups.
- **C** The list uses native automation fixtures and shared run-bar words.
- **F** Rows open their automation; the latest run needs that extra step.
- **G** Trigger, state and last outcome stay together.
- **S** Loaded rows only; no failed-read or empty list was forced.
- **D** Names use up to two lines; schedules extend below the fold.
- **T** Small run metadata remains denser than the main label.
- **K** Waiting text uses warn on sf, 4.743:1 light; platform badge differs.
- **A** Run bars have a spoken count and outcome summary. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** On and waiting are distinct; no invented failed thread flag.

## Settings

You, the named assistant, This Whombat, Screens and Advanced remain the shipped groups; Theme is direct.

### ios

[Light](png/ios-settings-light.png) · [Dark](png/ios-settings-dark.png) · [Accessibility tree](ios-settings-light.txt)

Mean 7.1 · 8/7/7/7/6/8/8/5/7/8

- **H** Grouped destinations are easy to scan.
- **C** Same settings groups with demo-only account options omitted.
- **F** Theme is direct; Vault and Spend require their existing deeper paths.
- **G** Each group has one short explanatory line.
- **S** Only loaded settings; unavailable settings were not exercised.
- **D** All top-level groups fit at the standard text size.
- **T** Group title and secondary line stay distinct.
- **K** iOS system badge: sampled red backgrounds limit white text to 3.570:1 light / 3.433:1 dark, below 4.5.
- **A** Group names and current theme are present in the tree. iOS AX snapshot inspected.
- **Q** Nothing is made to look like an urgent setting.

### android

[Light](png/android-settings-light.png) · [Dark](png/android-settings-dark.png) · [Accessibility tree](android-settings-light.txt)

Mean 7.3 · 8/7/7/7/6/8/8/8/6/8

- **H** Grouped destinations are easy to scan.
- **C** Same settings groups with demo-only account options omitted.
- **F** Theme is direct; Vault and Spend require their existing deeper paths.
- **G** Each group has one short explanatory line.
- **S** Only loaded settings; unavailable settings were not exercised.
- **D** All top-level groups fit at the standard text size.
- **T** Group title and secondary line stay distinct.
- **K** Muted group text and platform tab badge are measured.
- **A** Group names and current theme are present in the tree. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Nothing is made to look like an urgent setting.

## Vault

Entries remain closed. Printer admin’s failing state is spoken, while its visible cue is a small status dot.

### ios

[Light](png/ios-vault-light.png) · [Dark](png/ios-vault-dark.png) · [Accessibility tree](ios-vault-light.txt)

Mean 7.1 · 8/7/6/7/6/7/7/8/7/8

- **H** Explanation and Your entries are separated.
- **C** Same Vault concept; native rows and extra Deploy key follow DemoRoot.
- **F** Opened by deep link here; find-from-Chat participant task is still untested.
- **G** Name and metadata share a row; the failing dot needs interpretation.
- **S** No unlock, reveal, empty or failed-read states were exercised.
- **D** Long rows scroll; Add to Vault stays above them.
- **T** Metadata is small but measured.
- **K** Muted/background and muted/card pairs are measured.
- **A** Rows speak their status and last-use time; no secret was opened. iOS AX snapshot inspected.
- **Q** Secrets stay closed and the AI-service caveat remains visible.

### android

[Light](png/android-vault-light.png) · [Dark](png/android-vault-dark.png) · [Accessibility tree](android-vault-light.txt)

Mean 7.0 · 8/7/6/7/6/7/7/8/6/8

- **H** Explanation and Your entries are separated.
- **C** Same Vault concept; native rows and extra Deploy key follow DemoRoot.
- **F** Opened by deep link here; find-from-Chat participant task is still untested.
- **G** Name and metadata share a row; the failing dot needs interpretation.
- **S** No unlock, reveal, empty or failed-read states were exercised.
- **D** Long rows scroll; Add to Vault stays above them.
- **T** Metadata is small but measured.
- **K** Muted/background and muted/card pairs are measured.
- **A** Rows speak their status and last-use time; no secret was opened. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Secrets stay closed and the AI-service caveat remains visible.

## Files

GAP: useFilesSpace returns false in fixtures. The route shows a heading and explanation, with no populated list.

### ios

[Light](png/ios-files-light.png) · [Dark](png/ios-files-dark.png) · [Accessibility tree](ios-files-light.txt)

GAP N-FILES: populated content unavailable in the fixture app.

- **H** GAP: demo deliberately disables Files content.
- **C** GAP: demo deliberately disables Files content.
- **F** GAP: demo deliberately disables Files content.
- **G** GAP: demo deliberately disables Files content.
- **S** GAP: demo deliberately disables Files content.
- **D** GAP: demo deliberately disables Files content.
- **T** GAP: demo deliberately disables Files content.
- **K** GAP: demo deliberately disables Files content.
- **A** GAP: demo deliberately disables Files content. iOS AX snapshot inspected.
- **Q** GAP: demo deliberately disables Files content.

### android

[Light](png/android-files-light.png) · [Dark](png/android-files-dark.png) · [Accessibility tree](android-files-light.txt)

GAP N-FILES: populated content unavailable in the fixture app.

- **H** GAP: demo deliberately disables Files content.
- **C** GAP: demo deliberately disables Files content.
- **F** GAP: demo deliberately disables Files content.
- **G** GAP: demo deliberately disables Files content.
- **S** GAP: demo deliberately disables Files content.
- **D** GAP: demo deliberately disables Files content.
- **T** GAP: demo deliberately disables Files content.
- **K** GAP: demo deliberately disables Files content.
- **A** GAP: demo deliberately disables Files content. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** GAP: demo deliberately disables Files content.

## Usage (Spend)

Spend has Today, 7 days and 30 days, with estimate details folded; it reads on open and pull, not live.

### ios

[Light](png/ios-usage-light.png) · [Dark](png/ios-usage-dark.png) · [Accessibility tree](ios-usage-light.txt)

Mean 6.7 · 7/7/5/7/6/6/7/8/7/7

- **H** One summary precedes three time-window tiles.
- **C** Same Spend destination; native fixture totals differ from web.
- **F** Advanced is its existing route; Usage is not a native destination name.
- **G** Totals have a window, tasks and reported cost.
- **S** Only populated totals; provider and failed-read states were not exercised.
- **D** Three narrow tiles make the metadata wrap.
- **T** Numbers are clear, metadata is small.
- **K** Muted/background and muted/card pairs are measured.
- **A** Each tile is one named element with tokens, tasks and cost. iOS AX snapshot inspected.
- **Q** Provider reporting is named, but estimate wording is behind More.

### android

[Light](png/android-usage-light.png) · [Dark](png/android-usage-dark.png) · [Accessibility tree](android-usage-light.txt)

Mean 6.6 · 7/7/5/7/6/6/7/8/6/7

- **H** One summary precedes three time-window tiles.
- **C** Same Spend destination; native fixture totals differ from web.
- **F** Advanced is its existing route; Usage is not a native destination name.
- **G** Totals have a window, tasks and reported cost.
- **S** Only populated totals; provider and failed-read states were not exercised.
- **D** Three narrow tiles make the metadata wrap.
- **T** Numbers are clear, metadata is small.
- **K** Muted/background and muted/card pairs are measured.
- **A** Each tile is one named element with tokens, tasks and cost. Android AX snapshot inspected; TalkBack traversal remains untested.
- **Q** Provider reporting is named, but estimate wording is behind More.

