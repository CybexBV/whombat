# Openings close by themselves (NOC)

A production server's opening in the commands' wall (`apps/agent-net`, one-person.md OP-07, OP-S114) used to last until
the runner sent a policy without it. A removal the daemon never got, or a runner that stopped, left it open with no end;
the runner also counted a failed removal as done. Ids NOC-01…NOC-05. Extends OP-S114 (“openings go with their turn, and
a "once" one a minute after its command”): that still says when the runner removes them.

| # | Decision | Why |
|---|---|---|
| NOC-01 | **Every opening the runner sends carries `ttlMs`, how long it holds from the moment the daemon takes the policy** (`TimedOpening`, at most `OPENING_TTL_MAX_MS`, 5 minutes; a policy with a longer one is refused and the one before stays). The daemon keeps each opening's end on its own monotonic clock (`HeldPolicy`) and decides every connection on the openings still holding. Production servers, the home networks and the local network don't lapse. | The daemon closes an opening by itself, whatever happens to the runner. A relative time needs no shared clock, and a monotonic one can't be stretched by a clock change. Letting the rest lapse would open production servers, not close them. |
| NOC-02 | **The runner leases openings: `OPENING_LEASE_MS`, 90 s, three of its half-minute renewals**. A turn's opening and a running command's “once” opening get the lease with every policy; a “once” opening whose command ended gets the time left until it closes. | If the runner stops renewing (crashed, hung, its updates failing), every opening is gone within 90 s. One lost renewal doesn't cut off a command that is running. |
| NOC-03 | **A removal the daemon didn't take is a failure**: `AgentNet.drop` and `closeAt` reject, and the turn logs it as an error (the opening still lapses at the daemon within its lease). Setting the policy for anything else (a turn's settings, a new opening, the renewals) still only logs, as before. | The caller learns the removal didn't happen. A failed opening or settings change already fails closed. |
| NOC-04 | **A tunnel to a production server ends with its opening**: the proxy checks those tunnels every second and after each new policy, and cuts one the wall no longer allows. Other tunnels aren't checked. | Otherwise an ssh session opened under an opening would outlive it. Public tunnels stay as they were. |
| NOC-05 | **No contracts release**: the policy's shape lives in `@whombat/agent-net`, which only the runner (same runtime bundle) speaks. A daemon from before this change ignores `ttlMs`; this daemon refuses a policy without it, so a mismatched pair stays closed. | The daemon and the runner always ship together. |
