# AI clients for the runner (SUB-09, contracts CT-72…CT-74, NX-37; manager MG-33). Claude Code and Codex are not part
# of the image any more: on an owner's request the manager installs the latest tested version the signed client channel
# names (Claude Code from Anthropic's own download site, checked against the channel's SHA-256) into
# /persist/whombat/clients/<provider>/<version>/ — unmodified, read-only, owned by whombat-manager,
# executable by the runner — and pushes the executable paths and digests to the runtime (`POST /clients`). The
# server keeps that status in WHOMBAT_CLIENTS_FILE, which the runner reads before each turn (Whombat SUB-25): it runs
# exactly that path after checking its sha256, so the pins come from the installed bundles, not from the image.
# The GitHub CLI is in the image, on the runner's PATH (sandbox.nix, NX-135). Provider sign-in CLIs run in the runner as
# whombat-runner; the credential homes are the runner's alone (the server has no access).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.clients;
  p = config.whombat.persistDir;
  inherit (lib) mkOption types;
in
{
  imports = [
    (lib.mkRemovedOptionModule [
      "whombat"
      "providers"
      "packages"
    ] "Claude Code and Codex are installed by the manager from the client channel (NX-37); set whombat.clients.channelKeys.")
  ];

  options.whombat.clients = {
    root = mkOption {
      type = types.str;
      default = "${p}/whombat/clients";
      readOnly = true;
      description = ''
        Where the manager installs the clients (<provider>/<version>/…, <provider>/current). Plain path segments
        only: the executable path the manager pushes must match the contract's pattern (no dot-directories).
      '';
    };
    statusFile = mkOption {
      type = types.str;
      default = "/run/whombat-clients/clients.json";
      readOnly = true;
      description = ''
        WHOMBAT_CLIENTS_FILE for server and runner: the server writes the manager's last client status there (0640,
        atomically; the directory is setgid whombat-runner), the runner only reads it.
      '';
    };
    channelKeys = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        The pinned client channel key document of this environment (the AssignmentKeys shape, CT-74; public,
        installed at /etc/whombat/tuf/client-channel-keys.json). null: the manager installs no clients and every
        Claude or Codex turn is refused with client.not_installed.
      '';
    };
    signInHosts = mkOption {
      type = types.listOf types.str;
      default = [
        "claude.ai"
        "console.anthropic.com"
        "platform.claude.com"
        "api.anthropic.com"
      ];
      description = ''
        Hosts the Claude sign-in console needs (claude auth login --claudeai in the runner, Whombat SUB-20), added
        to the runner's egress allowlist (WHOMBAT_SANDBOX_EGRESS_ALLOW) next to its built-in provider hosts.
      '';
    };
  };

  config = {
    warnings = lib.optional (config.whombat.environment == "prod" && cfg.channelKeys == null)
      "whombat.clients.channelKeys is not set: this prod image installs no AI clients (docs/runbooks/updates.md, “AI client channel”)";

    # Claude Code is glibc-linked (interpreter /lib64/ld-linux-x86-64.so.2) and must run unmodified: nix-ld provides
    # the loader (glibc only). Codex is static-pie and needs nothing.
    programs.nix-ld = {
      enable = true;
      libraries = lib.mkForce [ ];
    };

    environment.etc."whombat/tuf/client-channel-keys.json" = lib.mkIf (cfg.channelKeys != null) {
      source = cfg.channelKeys;
      mode = "0444";
    };

    systemd.tmpfiles.settings."20-whombat-clients" = {
      # Written only by the manager; everyone may read and execute (the runner runs from here).
      ${cfg.root}.d = {
        mode = "0755";
        user = "whombat-manager";
        group = "whombat-manager";
      };
      "${p}/manager/clients".d = {
        mode = "0700";
        user = "whombat-manager";
        group = "whombat-manager";
      };
      # The server writes the status file here; its group (setgid) lets the runner read it and nobody else.
      "/run/whombat-clients".d = {
        mode = "2750";
        user = "whombat";
        group = "whombat-runner";
      };
    };

    systemd.services.whombat-server.environment = {
      WHOMBAT_CLIENTS_FILE = cfg.statusFile;
      WHOMBAT_CLIENTS_ROOT = cfg.root;
    };
    systemd.services.whombat-runner.environment = {
      WHOMBAT_CLIENTS_FILE = cfg.statusFile;
      # The runner runs a client only from inside the manager's install root, every directory above it out of the
      # server's reach (Whombat SUB-45; its default is this path too, set explicitly so the two can't drift).
      WHOMBAT_CLIENTS_ROOT = cfg.root;
      WHOMBAT_CREDENTIALS_ROOT = "${p}/whombat/credentials";
      # nix-ld's variables are session-only; services need them explicitly.
      NIX_LD = "/run/current-system/sw/share/nix-ld/lib/ld.so";
      NIX_LD_LIBRARY_PATH = "/run/current-system/sw/share/nix-ld/lib";
      # Self-updaters off (the installs are read-only anyway; the runtime sets the per-home settings, SUB-17).
      DISABLE_AUTOUPDATER = "1";
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    };
  };
}
