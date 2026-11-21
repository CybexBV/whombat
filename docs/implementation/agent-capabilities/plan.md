# Agent capabilities — implementation plan

Assignment: `assignment.md` (this folder). Decisions: `docs/decisions/{browser,skills-library,agent-roles,spend}.md`
(BT-, SL-, AR-, SP-). Ledger: `ledger.md`. Evidence: `verification.md`.

## Phases

| # | Phase | Owner | State |
|---|---|---|---|
| 0 | Read, decide (four decision files), ledger | lead | |
| 1 | Contracts 0.20.0 (CT-119…): keys, roles, Vault `login`, manifest `roles`/`requires`, scanner, browser + skill MCP tools, proposals, skill switches, skill hint, scratch access, spend, fixtures; release, tag, vendor | lead + agent `contracts` | |
| 2a | Runtime browser: host process (Playwright + filtering proxy), socket protocol, MCP tools, sessions, downloads, Vault `login` fill + Test sign-in, prompt lines, `host.browser` | agent `rt-browser` (branch `capabilities-browser`) | |
| 2b | Runtime skills: switches, role packs on hire, proposals + own packs, skill uses, slash hint, scratch workspace (runner + agent-runtime), learn-this prompt, scanner wiring, doctor | agent `rt-skills` (branch `capabilities-skills`) | |
| 2c | Runtime roles + spend: role guidance in both builders, defaults, feedback assessor suggestion, `spend.overview` + agent line | agent `rt-roles-spend` (branch `capabilities-spend`) | |
| 2d | Shipped packs content (11 packs, SOURCES.md) | agent `packs` (branch `capabilities-packs`) | |
| 2e | App web + Android: avatars (checkpoint), role colours, hire/onboarding skills, Skills tab, Vault login, key rows, Spend tab, profile lines, slash autocomplete, Android screens | agent `app` (whombat-app `capabilities`) | |
| 2f | Appliance: `whombat-browser` unit, wall, memory switch, VM test, toolchain libraries, scenarios `r-browser`, `s-skills-roles` | agent `appliance` (appliance `capabilities`) | |
| 3 | Integrate runtime branches, full checks, docs | lead | |
| 4 | Candidate 0.18.0: app 0.11.0 vendored, runtime pinned, validate incl. VM test | lead + agent | |
| 5 | Review: security lens, product lens; fix | agents | |
| 6 | Ship: merge, push, tags, deploy dev (managed stack + monolith, Chromium on the host), live checks | lead | |
