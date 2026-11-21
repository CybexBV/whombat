# PostgreSQL 17, local only (MA-12, NX-18). Unix socket with peer authentication for the runtime;
# loopback TCP requires SCRAM (for tools that cannot use the socket); nothing else is accepted.
# The major version is part of the data path (/persist/postgres/17) because a major upgrade is a
# separate, manager-driven class (MD-09), never an implicit effect of a host update.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  p = config.whombat.persistDir;
in
{
  options.whombat.postgres.sharedBuffers = lib.mkOption {
    type = lib.types.str;
    default = "256MB";
  };

  config = {
    services.postgresql = {
      enable = true;
      package = pkgs.postgresql_17;
      dataDir = "${p}/postgres/17";
      enableTCPIP = false; # listen_addresses is set explicitly below
      settings = {
        listen_addresses = lib.mkForce "127.0.0.1,::1";
        password_encryption = "scram-sha-256";
        ssl = false; # loopback only
        shared_buffers = config.whombat.postgres.sharedBuffers;
        # Logs carry no statement text or parameters (no content in logs, NX-16).
        log_statement = "none";
        log_min_duration_statement = -1;
        log_min_error_statement = "panic";
        log_error_verbosity = "terse";
        log_connections = false;
        log_disconnections = false;
        log_line_prefix = "[%p] ";
        # Durable by default: an acknowledged commit survives power loss (hardware-qualified).
        fsync = true;
        synchronous_commit = "on";
        full_page_writes = true;
      };
      authentication = lib.mkForce ''
        # TYPE  DATABASE  USER      ADDRESS        METHOD
        local   all       postgres                 peer${lib.optionalString config.whombat.backup.enable " map=whombat-superuser"}
        ${lib.optionalString config.whombat.backup.enable "local   whombat   whombat_backup           peer map=whombat-backup"}
        local   whombat   whombat                  peer
        ${lib.optionalString config.whombat.backup.enable ''
          # A backup opened for reading (backup NX-505): the backup role loads it, the runtime reads it.
          local   /^whombat_peek_[0-9a-f]{12}$   whombat_backup   peer map=whombat-backup
          local   /^whombat_peek_[0-9a-f]{12}$   whombat          peer
        ''}
        host    all       all       127.0.0.1/32   scram-sha-256
        host    all       all       ::1/128        scram-sha-256
      '';
      ensureDatabases = [ "whombat" ];
      ensureUsers = [
        {
          name = "whombat";
          ensureDBOwnership = true;
        }
      ];
    };

    # MemoryMin (MP-02, NX-142): shared_buffers (256 MB) and a few backends.
    whombat.slices.critical.units.postgresql = lib.mkDefault 320;
    systemd.services.postgresql = {
      requires = [ "whombat-persist.target" ];
      after = [ "whombat-persist.target" ];
      serviceConfig = {
        Slice = "whombat-critical.slice";
        OOMScoreAdjust = -900;
        IPAddressDeny = "any";
        IPAddressAllow = "localhost";
      };
    };
  };
}
