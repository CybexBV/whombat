# Chat runtime — assignment

Spec: `docs/decisions/chat-runtime.md` (CR-01…CR-11). Mockup: app `docs/design-handoff/chat-runtime/index.html`
(John approved it: “I love it. Implement this fully.”). Contracts 0.96.0 (CT-456…) are vendored on the integration
branches `cr` (Whombat `~/Code/.wt/whombat-cr`, app `~/Code/.wt/app-cr`).

## Streams

| Stream | Worktree / branch (from `cr`) | Owns |
| --- | --- | --- |
| R — runner | `~/Code/.wt/whombat-cr-runner` / `cr-runner` | `packages/agent-runtime`, `apps/runner` |
| S — server | `~/Code/.wt/whombat-cr-server` / `cr-server` | `apps/server` (migration 0118) |
| W — web | `~/Code/.wt/app-cr-web` / `cr-web` | `apps/web`, `packages/client` |
| M — Android | `~/Code/.wt/app-cr-mobile` / `cr-mobile` | `apps/mobile` |

Decision ids: Whombat runner `docs/decisions/chat-runtime-runner.md` CR-R01…, server `docs/decisions/chat-runtime-server.md`
CR-S01…; app `docs/decisions/chat-runtime.md` web AP-2680…AP-2714, Android AP-2715…AP-2749.

## Rules for every stream

- DEV is fast: one quick check per repo at the end (`TMPDIR=~/.cache/wb-tmp pnpm format && pnpm check`; Whombat server
  also `pnpm test:server` once). No VM tests, no candidate/ship steps, no waiting on CI. One repository's check at a time.
- Own ports and throwaway databases; never stop, reset or `down -v` shared containers.
- **Never run a real fast-mode turn or any paid model call** to test: fast mode on Claude bills usage credits. Use the
  recorded fixtures and fakes; a live CLI may be run only for `--version`/`initialize`/`model/list`-style calls that
  make no model request.
- Commits small, imperative, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge
  into `cr`/`main`; the orchestrator merges.
- Words a person sees come from contracts' `text/chat-runtime.ts` / `text/models.ts`; don't invent new copy in code
  without adding it there (tell the orchestrator if a string is missing).
- No idle waits: when done, report what works and what can only be seen later.
