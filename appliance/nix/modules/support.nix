# Remote help (Whombat RH-01…RH-13; NX-411…NX-424): an owner lets Whombat support into this Whombat for a while, and
# sees who is in and what they did.
#
# - `whombat-support` keeps the owner's grant (/var/lib/whombat-support/grant.json), answers the runtime server and the
#   manager on /run/whombat-support/api.sock, and only while a grant runs dials the relay as the device's support worker
#   (the box's own outgoing line, NX-22: nothing listens on any network, there is no SSH daemon) and serves SSH to
#   Whombat support over it: a certificate from the support CA pinned here, for this device, and on prod the help code.
#   Every visit is recorded in the state directory for the owners (RH-07).
# - Root, deliberately without most of the usual sandbox (NX-412): “Look and fix” is a root command line, restarts and
#   connections to the box's own ports and sockets, so it must be real root. Look runs as `whombat-support-look`, which
#   reads the journal and nothing else (NX-415). When a grant ends, what a visit left running in the unit's cgroup is
#   ended (NX-418).
# - The socket is systemd's: 0660 root:whombat-support, a group of the runtime server and the manager only; the service
#   also checks the peer's uid (the server everything, the manager the state only, root everything).
# - The CA is the image's (`whombat.support.caKeys` → /etc/whombat/support-ca.pub): the DEV CA in images for the dev
#   instance, the prod CA in prod images once it exists (RH-10); none, and remote help isn't available (NX-416).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.support;
  inherit (lib) mkOption types;
  ids = config.whombat.ids;
  socket = "/run/whombat-support/api.sock";
  caFile = "/etc/whombat/support-ca.pub";
  devCa = ../../manifest/dev-instance/support-ca.pub;
  # The key lines of a CA file (`ssh-ed25519 <base64> …`), by their key.
  keysOf =
    f:
    map (l: lib.elemAt (lib.splitString " " l) 1) (
      lib.filter (lib.hasPrefix "ssh-ed25519 ") (map lib.trim (lib.splitString "\n" (builtins.readFile f)))
    );
in
{
  options.whombat.support = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Remote help (Whombat RH-01, NX-411): the support service and its socket. On in the appliance profile; nobody gets in
        unless an owner turns it on, for a while, and only with a certificate from the CA the image pins.
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-support;
      defaultText = lib.literalExpression "pkgs.whombat-support";
    };
    caKeys = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        The Whombat support CA's public keys (OpenSSH lines, `ssh-ed25519 <base64> [comment]`), installed as
        ${caFile}: certificates signed by them, for this device, are the only way in (RH-05). Null, or a file without a
        key, and remote help isn't available here. DEV images pin manifest/dev-instance/support-ca.pub, prod images
        manifest/prod/support-ca.pub once it exists; prod never pins the DEV CA (NX-416).
      '';
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The support socket (WHOMBAT_SUPPORT_SOCKET of the runtime server), 0660 root:whombat-support.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        # Remote help is a Whombat Link feature (LNK-07): it comes through the relay with Whombat support's CA, so an
        # image whose boxes can't have Link has none. At runtime the manager hands out its tickets only while Link is
        # starting, on or in grace.
        assertion = config.whombat.link.possible;
        message = "whombat.support (remote help) needs Whombat Link: no environment of this image has a control";
      }
      {
        # DEV keys can never open a customer's box (RH-05): not the DEV file, nor any key in it.
        assertion =
          !(
            config.whombat.environment == "prod"
            && cfg.caKeys != null
            && (cfg.caKeys == devCa || lib.any (k: lib.elem k (keysOf devCa)) (keysOf cfg.caKeys))
          );
        message = "whombat.support.caKeys: a prod image never pins the DEV support CA (manifest/dev-instance/support-ca.pub)";
      }
    ];

    # ---- The accounts (NX-08: fixed ids) --------------------------------------------------------------------------
    # Look's commands run as this user: the journal (content-free, NX-16) and the world-readable system; nothing of
    # /persist's data, the record or the grant. It owns nothing and can't log in.
    users.users.whombat-support-look = {
      isSystemUser = true;
      uid = ids.whombat-support-look;
      group = "whombat-support-look";
      extraGroups = [ "systemd-journal" ];
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-support-look.gid = ids.whombat-support-look;
    # The socket's callers: the runtime server (owners' remote help) and the manager (status.report's state).
    users.groups.whombat-support = {
      gid = ids.whombat-support;
      members = [
        "whombat"
        "whombat-manager"
      ];
    };

    environment.etc."whombat/support-ca.pub" = lib.mkIf (cfg.caKeys != null) {
      source = cfg.caKeys;
      mode = "0444";
    };

    # ---- The socket: systemd's, so the runtime reaches it while the service restarts -------------------------------
    systemd.sockets.whombat-support = {
      description = "Whombat support socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = socket;
        SocketUser = "root";
        SocketGroup = "whombat-support";
        SocketMode = "0660";
        DirectoryMode = "0755";
        RemoveOnStop = true;
      };
    };

    systemd.services.whombat-support = {
      description = "Whombat remote help: the owners' grant, and Whombat support's way in while it lasts";
      # At boot too: a grant that runs (Forever on a DEV box) dials the relay without anyone asking first.
      wantedBy = [ "multi-user.target" ];
      requires = [ "whombat-support.socket" ];
      after = [
        "whombat-support.socket"
        "whombat-persist.target"
      ];
      # Look and fix see the commands a root login would (NX-412).
      environment.PATH = lib.mkForce "/run/wrappers/bin:/run/current-system/sw/bin";
      serviceConfig = {
        Type = "notify";
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/whombat-support"
          "--environment"
          config.whombat.environment
          "--ca-keys"
          # With environments (environment.nix) the box's environment picks the CA (LNK-01a); else the image's.
          (if config.whombat.environments != { } then "/run/whombat/environment/support-ca.pub" else caFile)
          "--state-dir"
          "/var/lib/whombat-support"
          "--device-file"
          "${config.whombat.persistDir}/identity/device.json"
          "--manager-socket"
          "/run/whombat-manager/api.sock"
          "--look-user"
          "whombat-support-look"
          "--runtime-uid"
          (toString ids.whombat)
          "--manager-uid"
          (toString ids.whombat-manager)
          "--socket"
          socket
        ];
        Restart = "always";
        RestartSec = "2s";
        TimeoutStopSec = "10s";
        # Stopping the service ends every visit and everything they started (the whole cgroup).
        KillMode = "control-group";
        # The grant, the events, the record and the SSH host key (made at the first start, never in the image).
        StateDirectory = "whombat-support";
        StateDirectoryMode = "0700";
        # 0022 like a root login: Look and fix inherits it, and a file support makes 0600 could break a service. The
        # service's own files are made 0600 and 0700 explicitly, whatever the mask.
        UMask = "0022";
        # The manager's socket (2750 whombat-manager:whombat-api, MG-11): support tickets and Look's reads (MG-118).
        SupplementaryGroups = [ "whombat-api" ];
        # Its memory may hold a help code: no core dumps (NX-16).
        LimitCORE = 0;
        # Deliberately no NoNewPrivileges, ProtectSystem, ProtectHome, PrivateTmp, PrivateDevices, capability bounds or
        # system call filter: they would follow every command of “Look and fix”, which must be real root (NX-412).
        # What keeps it safe is who gets in, not what root may do once in (RH-05).
      };
    };
  };
}
