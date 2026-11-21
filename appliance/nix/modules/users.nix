# Service accounts (MA-12, NX-08). No account can log in; uids are fixed.
{ config, lib, ... }:
let
  ids = config.whombat.ids;
  sb = config.whombat.sandbox.uidRange;
  system = name: uid: extra: {
    users.${name} = {
      isSystemUser = true;
      inherit uid;
      group = name;
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    }
    // extra;
    groups.${name}.gid = uid;
  };
in
{
  users = lib.mkMerge [
    (system "whombat-manager" ids.whombat-manager { extraGroups = [ "whombat-admin" ]; })
    (system "whombat" ids.whombat {
      extraGroups = [
        "whombat-workspaces"
        "whombat-api"
      ];
    })
    (system "whombat-runner" ids.whombat-runner {
      extraGroups = [ "whombat-workspaces" ];
      # Per-task sandbox ids are subordinate ids of the runner (user namespaces, W3-SBX).
      subUidRanges = [
        {
          startUid = sb.start;
          count = sb.count;
        }
      ];
      subGidRanges = [
        {
          startGid = sb.start;
          count = sb.count;
        }
      ];
    })
    # The tty1 console (NX-32): reads /run/whombat/console/console.json through its group, nothing else.
    (system "whombat-console" ids.whombat-console { })
    {
      groups.whombat-workspaces.gid = ids.whombat-workspaces;
      # /run/whombat/admin.sock (runtime admin API, MG-12) and /run/whombat-manager/api.sock (MG-11).
      groups.whombat-admin.gid = ids.whombat-admin;
      groups.whombat-api.gid = ids.whombat-api;
    }
  ];

  assertions = [
    {
      assertion = sb.start >= 1000000 && sb.count >= 1024;
      message = "whombat.sandbox.uidRange must be above 1000000 and hold at least 1024 ids";
    }
  ];
}
