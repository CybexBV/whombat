# A database or backup Whombat refuses

Whombat checks a database before it runs on it (`whombat schema-check`, the start, `whombat migrate`, a restore) and
refuses one it can't use, saying why and what to do. Nothing is changed when it refuses.

- **A database from before the baseline** (its first migration is `0000_init`): it is never converted. Start Whombat on
  a new, empty database (an appliance: a fresh install; development: a new `DATABASE_URL`) and leave the old one as it
  is.
- **A database of the chain before this one** (Whombat before 0.268.0): release 0.268.0 moves such a database across
  when it starts once. Update to 0.268.0 first, let it start, then update to the newer release. A backup made before
  0.268.0 is restored with 0.268.0 first (a build of it is kept for that), then updated.
- **A newer database**: a newer Whombat migrated it. Run that Whombat again, or restore a backup made for this version.
- **Another history**: the database was migrated by something else. Run the Whombat that last migrated it, or restore a
  backup made for this version.
- **An unsupported PostgreSQL major**: back up, move the data to a supported major, then start again.

The rules behind these answers: `docs/decisions/managed-db.md` and `docs/decisions/report-trackers.md` (TA-127).
