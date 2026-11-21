# Runtime documentation after the repository split

- **RD-01 — Describe runtime ownership explicitly.** **Superseded in part by one-person.md OP-S114**: computerd is now `apps/agent-net`, the commands' proxy; the rest holds. Runtime workspaces are server, runner, CLI, computerd,
  agent-runtime, computer and node-io, plus package/prompt tooling. Web, mobile, widget, client, tokens,
  avatars, brand and visual tooling belong to whombat-app. Pure core, fixtures and the other contracts
  belong to whombat-contracts. Runtime consumes pinned app artifacts and contracts tarballs, not sibling
  source workspaces (managed-runtime MR-01/MR-02). Historical design references stay in place.
- **RD-02 — Keep Node mechanics separate from policy.** The new `@whombat/node-io/http` and `/tar`
  entry points are Node-only extraction boundaries. Transport/header/PAX mechanics
  may be shared; destination checks, credentials, cancellation/deadlines, limits, error mapping and archive
  acceptance stay with their callers. Core stays pure and vendored. This documentation does not change
  permissions, signing, write paths, events, leases or fencing.
- **RD-03 — Document the commands that exist.** Runtime `pnpm dev` starts server + runner; the CLI unpacks
  a verified app artifact rather than compiling UI. For a browser on the runtime development server, unpack
  it first, enable static serving and set `PUBLIC_URL` to that server. The app repository owns browser and
  visual scripts. The Titan workflow selects Node 24.18.0 explicitly and uses `~/.cache/wb-tmp` because
  host `/tmp` exhausts inodes. Agent shipping instructions and resource/permission rules remain intact.
- **RD-04 — Keep the runner origin aligned with the development port.** The copied `.env.example`
  explicitly sets `WHOMBAT_SERVER_URL=http://localhost:4400`. Changing `PORT` alone leaves the runner
  connecting there. Development instructions require updating that URL alongside `PORT`, or removing
  the setting so the runner falls back to `http://localhost:$PORT`. Runtime defaults remain unchanged.
- **RD-05 — Describe the extracted runtime coordinators.** The architecture guide names `automations/engine.ts`
  as the lifecycle and pass coordinator, its `engine/` collaborators, `automations/steps.ts` as the central
  step command surface with typed `steps/` handlers, and `runner/turn.ts` as the phase coordinator with `turn/`
  collaborators owning phase work and turn state. PGG-05 points to `automations/engine/lock.ts` `takeLock()`;
  its driver limitations and application questions are unchanged.

Validation: audit documented scripts against root/workspace manifests, runtime static-directory and startup
code, and app/contracts source ownership. Check local paths and sibling documentation links without changing
sibling repositories. No runtime or UI behavior changed; parent performs full verification after integration.
