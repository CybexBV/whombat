# Shared options of the appliance modules. Component-specific options live next to their module.
{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  options.whombat = {
    environment = mkOption {
      type = types.enum [
        "local"
        "dev"
        "prod"
      ];
      default = "dev";
      description = ''
        Deployment environment (MA-14). Selects which control service, TUF root and relay the device
        trusts. Development-only conveniences (plain storage, the fake activator, stand-in runtime)
        are refused when this is "prod".
      '';
    };

    edition = mkOption {
      type = types.enum [
        "commercial"
        "community"
      ];
      default = "commercial";
      description = ''
        The product edition (Whombat HE-58, NX-445), inert since Whombat LNK-01 (one image for everyone; deleted in phase
        2). Every box makes its identity itself, is claimed on its own page and can have Whombat Link: what follows Link
        (remote help, the own address, the hosted app) follows `whombat.link.possible` (environment.nix) and, at runtime,
        the box's Link state. `community` still marks the community test image (its own TUF repository and keys, no
        environment with a control: nix/profiles/community-instance.nix) and its configuration files.
      '';
    };

    platform = mkOption {
      type = types.enum [
        "factory"
        "self-installed"
      ];
      default = "factory";
      description = ''
        What the appliance runs on (PI-02, NX-50, PI-22). `factory`: the Whombat device the factory installs and
        provisions, a UEFI machine with a TPM 2.0, LUKS2 volumes sealed to the TPM, Secure Boot with per-device keys
        enrolled by systemd-boot (was `hardware`). `self-installed`: a Whombat installed from the ISO on a dedicated
        x86_64 UEFI machine or in a VM on any KVM hypervisor (PI-18, PI-21; q35, OVMF without enrolled keys, no TPM;
        was `proxmox-vm`): storage mode `host-encrypted` (the same GPT and btrfs layout without LUKS), Secure Boot
        keys generated but not enrolled, no TPM seal. The only platform for self-installation in prod.
      '';
    };

    persistDir = mkOption {
      type = types.str;
      default = "/persist";
      readOnly = true;
      description = "Mount point of the encrypted persistent-state filesystem (MA-12).";
    };

    ids = mkOption {
      description = ''
        Fixed uids/gids (NX-08). They must never change between host generations because
        /persist is owned by them and a fallback generation must read the same files.
      '';
      default = { };
      type = types.submodule {
        options = {
          whombat = mkOption {
            type = types.int;
            default = 951;
          };
          whombat-runner = mkOption {
            type = types.int;
            default = 952;
          };
          whombat-manager = mkOption {
            type = types.int;
            default = 950;
          };
          whombat-workspaces = mkOption {
            type = types.int;
            default = 953;
            description = "gid shared by server and runner for workspaces";
          };
          whombat-backup = mkOption {
            type = types.int;
            default = 954;
            description = "uid/gid of the backup service (W3-BK)";
          };
          whombat-admin = mkOption {
            type = types.int;
            default = 956;
            description = "gid of the runtime admin socket's users (manager, boot assessment)";
          };
          whombat-api = mkOption {
            type = types.int;
            default = 957;
            description = "gid of the manager API socket's users (runtime, later backup)";
          };
          whombat-console = mkOption {
            type = types.int;
            default = 959;
            description = "uid/gid of the tty1 console (reads the runtime's console state file, NX-32)";
          };
          whombat-kiosk = mkOption {
            type = types.int;
            default = 960;
            description = "uid/gid of the graphical console's kiosk (cage + Chromium on tty1, NX-78)";
          };
          # 961 was the agents' browser host's (NX-94), gone with it (NX-438): not reused, a box may still have its files.
          # 962 was computerd's (NX-129): the commands' network daemon keeps it (NX-456). 963 (whombat-computers) and 964
          # (incus-admin) went with the computers (NX-455): not reused.
          whombat-agent-net = mkOption {
            type = types.int;
            default = 962;
            description = ''
              uid/gid of the agent's commands' network daemon (Whombat one-person.md OP-07, I-4; NX-456): the proxy behind
              the commands' 127.0.0.1:3128, its socket's group (the runner is a member)
            '';
          };
          whombat-hosts = mkOption {
            type = types.int;
            default = 965;
            description = ''
              uid/gid of the hosts service (Whombat ONE-11, NX-152): /persist/hosts; its group is the server's way to the
              API socket and the service token. The egress table names the uid.
            '';
          };
          whombat-voice = mkOption {
            type = types.int;
            default = 966;
            description = "uid/gid of the voice service (speech for the desk display, NX-175); its socket is group whombat";
          };
          whombat-presence = mkOption {
            type = types.int;
            default = 967;
            description = "uid/gid of the presence service (the camera for the desk display, NX-280); its socket is group whombat";
          };
          whombat-bluetooth = mkOption {
            type = types.int;
            default = 968;
            description = "uid/gid of the Bluetooth service (pairing devices with the box, NX-354); its socket is group whombat";
          };
          whombat-support-look = mkOption {
            type = types.int;
            default = 969;
            description = ''
              uid/gid of remote help's Look commands (NX-415): the journal's group and nothing else, no login, owns nothing
            '';
          };
          whombat-support = mkOption {
            type = types.int;
            default = 970;
            description = "gid of the support socket's callers: the runtime server and the manager (NX-414)";
          };
          whombat-voice-models = mkOption {
            type = types.int;
            default = 972;
            description = ''
              uid/gid of the voice models' fetcher (NX-473): owns /persist/voice-models, the only one with the network
              there; its socket is group whombat
            '';
          };
          whombat-containers = mkOption {
            type = types.int;
            default = 971;
            description = ''
              uid/gid of the agent's container engine (rootless Podman, Whombat OP-16, I-2; NX-457): owns the containers'
              storage; its group is the socket's (the runner and the server are members)
            '';
          };
          whombat-peek = mkOption {
            type = types.int;
            default = 973;
            description = ''
              gid of a backup opened for reading (NX-505): the backup service makes the peek's files this group's, the
              runtime server is a member and reads them, nobody may write them
            '';
          };
        };
      };
    };

    sandbox.uidRange = mkOption {
      description = ''
        Per-task sandbox uid/gid range (MA-12). Delegated to whombat-runner via /etc/subuid and
        /etc/subgid; never used by any other account. The runner sandbox (W3-SBX) allocates from it.
      '';
      default = { };
      type = types.submodule {
        options = {
          start = mkOption {
            type = types.int;
            default = 2000000;
          };
          count = mkOption {
            type = types.int;
            default = 65536;
          };
        };
      };
    };
  };
}
