# Persistent-state layout (MA-12, NX-06). /persist is the only place with customer or device state;
# the root filesystem holds the Nix store, profiles, logs and caches only. Owners and modes are
# enforced on every boot by systemd-tmpfiles (type `d` adjusts an existing directory's owner/mode but
# never recurses, so large workspaces are not re-chowned).
{ config, lib, ... }:
let
  p = config.whombat.persistDir;
  dir = mode: user: group: {
    d = {
      inherit mode user group;
    };
  };
in
{
  systemd.tmpfiles.settings."10-whombat-persist" = lib.mkMerge [ {
    "${p}" = dir "0755" "root" "root";

    # Device identity (MA-03). Traversable, not listable. Files (written by provisioning):
    #   device.json        0644 root            {deviceId, env, ...}   read by helper/manager/runtime
    #   management.key     0600 whombat-manager  PKCS#8 PEM Ed25519     manager only
    #   management.pub     0644 root            raw key, base64url
    #   content.key        0600 root            PKCS#8 PEM Ed25519     runtime via LoadCredential
    #   content.peerid     0644 root            libp2p PeerId (12D3KooW…)
    #   claim.json         0600 root            claim secret hash      runtime via LoadCredential
    "${p}/identity" = dir "0711" "root" "root";

    "${p}/postgres" = dir "0755" "root" "root";
    "${p}/postgres/17" = dir "0700" "postgres" "postgres";

    "${p}/whombat" = dir "0755" "root" "root";
    "${p}/whombat/home" = dir "0700" "whombat" "whombat"; # WHOMBAT_HOME: files, skills
    "${p}/whombat/workspaces" = dir "2770" "whombat-runner" "whombat-workspaces";
    # credentials/<account>/<provider>/ are created by the runtime (0700 each, W3-PV/W3-SBX).
    "${p}/whombat/credentials" = dir "0700" "whombat-runner" "whombat-runner";

    "${p}/manager" = dir "0700" "whombat-manager" "whombat-manager"; # journal, TUF cache, staging, known-good
    # `whombat-manager environment set`'s moves (ONE-06): root's alone, never under the manager's own folder (R1 #13).
    "${p}/environment-moves" = dir "0700" "root" "root";

    "${p}/secrets" = dir "0700" "root" "root"; # master.key; services receive it via LoadCredential
  }
  # With the backup service, W3-BK's module owns /persist/backup (whombat-backup 0711).
  (lib.mkIf (!config.whombat.backup.enable) { "${p}/backup" = dir "0700" "root" "root"; })
  ];

  # Everything that needs /persist waits for it (it is unlocked in the initrd, see storage.nix).
  systemd.targets.whombat-persist = {
    description = "Whombat persistent state is mounted and laid out";
    requires = [ "systemd-tmpfiles-setup.service" ];
    after = [ "systemd-tmpfiles-setup.service" ];
    unitConfig.RequiresMountsFor = [ p ];
    wantedBy = [ "multi-user.target" ];
  };
}
