# Deliver the Hermes integration with its host

*Superseded by NX-483 and NX-484 (2026-10-28): Hermes and the plugin are part of the runtime bundle, so the plugin
always comes with the runtime it was built from; each activation checks the installed provider registration, and a
failure goes back by itself. Kept for the incident.*

## Incident (2026-10-26)

John retried Dusty after candidate 0.153.5 / `whombat-dev-20261026.2`. Home's runner selected
`whombat-claude-gateway`, but Hermes failed before making a gateway request with “Unknown provider”.
The runtime was Whombat `56ffc162`; the reused host `whombat-20261025.7` carried Hermes and Whombat's Python plugin
from Whombat `b425f50a`. The provider existed in the runtime checkout and its tests, but not in the installed host.
Home's Healthy / known-good update status checked the running services, not that provider registration.

## Decision

`dev/candidate` compares `packages/hermes-whombat` between the requested Whombat revision and the revision used to
build the actual reused host. Compare with the host's pin, even after one or more runtime-only releases of newer
Whombat pins. Follow an explicit `--reuse-host` that names a runtime-only release to its real host too.

Changed Python integration or an unknown host source requires a host release. Refuse an explicit incompatible
`--reuse-host`. A candidate already published without its required host must be replaced by a new candidate/version,
not treated as finished or republished with versions TUF already holds. Unpublished interrupted runs still resume.
Other runtime changes retain the existing fast runtime-only delivery.

The Hermes package's install check imports the installed gateway integration and verifies its provider registry.
The regression tests use real Git trees to distinguish JavaScript-only changes from Python changes, and release
records where the newest runtime and the reused host have different Whombat pins.

Ship the correction through `dev/candidate` as a host release. Confirm Home's installed provider registration in a
temporary empty Hermes home, without reading or changing John's personal configuration, conversation or credentials.
The earlier native Fusebox probe established transport compatibility; it did not exercise Home's installed package.
