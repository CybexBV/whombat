# Factory provisioning on the device (NX-24). An unprovisioned appliance (no
# /persist/identity/device.json) provisions itself when the factory medium appears: a filesystem
# labelled WBFACTORY with station.json and the station's provisioning token. The cards are
# written back to the medium. The token is read from the medium only and never copied to the disk.
# Runtime, manager and helper don't start until the device is provisioned.
#
# A self-installed appliance (whombat.provisioning.selfRegister, CC-10, NX-33) provisions itself at boot
# instead: whombat-self-provision registers with control's credential-free self-register endpoint while
# /persist/identity/device.json is absent. It writes no cards and gets no disk recovery key (PI-19, NX-90); the
# console code claims it. A key an earlier image left for the console (PI-04) and nobody confirmed is removed at
# boot with its hash (whombat-recovery-key-drop).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  p = config.whombat.persistDir;
  cfg = config.whombat.provisioning;
  deviceFile = "${p}/identity/device.json";
  # The manager's journal (MG-17): its A/B records exist once the factory tuple is recorded (MG-20).
  journal = "${p}/manager/journal";
  # The manager's request to give a retired, never-claimed self-installed appliance new keys (MG-30, NX-35).
  reregisterRequest = "${p}/manager/reregister.json";
  mediumUnit = "dev-disk-by\\x2dlabel-WBFACTORY.device";
  # What starts once the box is provisioned: everything that waited for device.json at boot. The hosts service isn't
  # part of the runtime target (hosts.nix), so it is named; without it a fresh box had no servers' service, and every
  # backup left the servers out, until its first restart (NX-510).
  startProvisioned = lib.concatStringsSep " " (
    [
      "whombat-manager.service"
      "whombat-runtime.target"
    ]
    ++ lib.optional config.whombat.hosts.enable "whombat-hosts.service"
  );
  json = pkgs.formats.json { };

  # Why the first start can't finish, for the console's starting screen (NX-526; whombat-console --start-file): written
  # when recording the factory tuple fails, removed when it succeeds. /run: a restart tries again from nothing.
  startProblemDir = builtins.dirOf cfg.startProblemFile;
  startProblem = cfg.startProblemFile;
  # start_problem KIND: release-missing (no update channel lists $rel), offline (the update repository can't be read),
  # failed (anything else). Nothing in it is secret: the image's release id.
  startProblemFn = ''
    start_problem() {
      install -d -m 0755 ${startProblemDir}
      ${pkgs.jq}/bin/jq -cn --arg p "$1" --arg r "''${rel:-}" '{v: 1, problem: $p, release: $r}' > ${startProblemDir}/.problem.json.tmp
      chmod 0644 ${startProblemDir}/.problem.json.tmp
      mv -f ${startProblemDir}/.problem.json.tmp ${startProblem}
      echo "the first start can't finish ($1); the console says so" | tee -a "''${log:-/dev/null}" >&2
    }
  '';

  # MG-20: record the factory tuple — the manager first (it refreshes TUF, finds the release in whichever channel lists
  # it and has the helper follow that channel (MG-182), and fills the mirror the helper verifies from), then the helper
  # (root), which also checks it is the booted host. $rel and $seed are shell variables of the caller; output goes to
  # $log. A failure says why on the console (the manager's exit status: 3 no channel lists the release, 4 the update
  # repository can't be read) and fails the unit, which tries again.
  # The caller defines start_problem first (startProblemFn).
  recordFactoryTuple = ''
    if [ -n "$rel" ]; then
      rc=0
      out=$(${pkgs.util-linux}/bin/runuser -u whombat-manager -- \
        ${config.whombat.manager.package}/bin/whombat-manager --config /etc/whombat/manager.json \
        provision --factory-release "$rel" 2>&1) || rc=$?
      printf '%s\n' "$out" | tee -a "$log"
      case "$rc" in
        0) ;;
        3) start_problem release-missing; exit 1 ;;
        4) start_problem offline; exit 1 ;;
        *) start_problem failed; exit 1 ;;
      esac
      if [ "$seed" = yes ]; then
        :
        ${lib.optionalString (config.whombat.helper.package != null) ''
          if ! ${config.whombat.helper.package}/bin/whombat-update-helper --config /etc/whombat/update-helper.json \
            seed-factory "$rel" 2>&1 | tee -a "$log"; then
            start_problem failed
            exit 1
          fi
        ''}
      fi
    else
      echo "no factory release: the manager is not provisioned" | tee -a "$log" >&2
    fi
    rm -f ${startProblem}
    systemctl --no-block start ${startProvisioned}
  '';

  # station.json's format without anything that belongs to a factory (whombat-provision self --config).
  community = config.whombat.edition == "community";
  selfSettings = json.generate "self-provision.json" (
    {
      v = 1;
      environment = config.whombat.environment;
      # Every box makes its identity itself (Whombat LNK-01): control first hears of it at link.begin.
      controlUrl = "";
      model = "self-installed";
      requireSecureBoot = cfg.selfRequireSecureBoot;
      platform = config.whombat.platform;
    }
    # A community box says so (NX-445); its identity is made like every box's.
    // lib.optionalAttrs community { edition = "community"; }
    # The box's environment decides its identity's env (LNK-01a, environment.nix).
    // lib.optionalAttrs (config.whombat.environments != { }) { environmentDir = "/run/whombat/environment"; }
  );
  pendingKey = "${p}/console/recovery-key.json";
in
{
  options.whombat.provisioning = {
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.whombat-provision;
      defaultText = lib.literalExpression "pkgs.whombat-provision";
    };
    factoryMedium = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Provision automatically from a WBFACTORY medium while unprovisioned.";
    };
    selfRegister = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Self-installed appliances (the downloadable ISO, CC-10): provision at boot while unprovisioned by
        registering with control's credential-free self-register endpoint (control must allow it,
        SELF_REGISTRATION=1). No cards and no disk recovery key (PI-19): the console shows the claim code. In
        prod only on the self-installed platform (asserted; PI-02, PI-18).
      '';
    };
    selfControlUrl = lib.mkOption {
      type = lib.types.str;
      default = config.whombat.manager.controlUrl;
      defaultText = lib.literalExpression "config.whombat.manager.controlUrl";
      description = "Control base URL for self-registration (the manager's control).";
    };
    selfRequireSecureBoot = lib.mkOption {
      type = lib.types.bool;
      default = config.whombat.platform == "factory";
      defaultText = lib.literalExpression ''config.whombat.platform == "factory"'';
      description = "Refuse to self-provision unless Secure Boot is enforced (self-installed has none, PI-02).";
    };
    selfFactoryRelease = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Release id of the installed tuple, recorded like a factory medium's factoryRelease (MG-20) after
        self-provisioning. null: the manager is not provisioned (the ISO build sets it).
      '';
    };
    startProblemFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/whombat-start/problem.json";
      readOnly = true;
      description = ''
        Why the first start can't finish (NX-526): the provisioning units write it when recording the factory release
        fails and remove it once that worked; the console's starting screen shows it (whombat-console --start-file).
      '';
    };
    selfSeedHelper = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run `whombat-update-helper seed-factory` after recording the release (MG-20).";
    };
  };

  config = {
    environment.systemPackages = [ cfg.package ];

    systemd.services.whombat-factory-provision = lib.mkIf cfg.factoryMedium {
      description = "Provision this appliance from the factory medium";
      # Wanted (not bound) by the medium: relabelling or re-reading the partition table re-announces the
      # device, and BindsTo= then stopped a running provisioning ("Requested transaction contradicts
      # existing jobs", killed mid-way). The script waits for the medium itself; ConditionPathExists keeps a
      # re-announced medium from provisioning twice.
      wantedBy = [ mediumUnit ];
      after = [
        mediumUnit
        "whombat-persist.target"
        "network-online.target"
        "whombat-tpm-seal.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "whombat-persist.target" ];
      unitConfig.ConditionPathExists = "!${deviceFile}";
      path = [
        pkgs.coreutils
        pkgs.util-linux
        pkgs.jq
        config.systemd.package
      ];
      serviceConfig = {
        Type = "oneshot";
        RuntimeDirectory = "whombat-factory";
        RuntimeDirectoryMode = "0700";
        PrivateTmp = true;
      };
      script = ''
        set -euo pipefail
        ${startProblemFn}
        udevadm settle --timeout=30 || true
        for _ in $(seq 30); do
          mount -o nosuid,nodev,noexec /dev/disk/by-label/WBFACTORY /run/whombat-factory && break
          sleep 1
        done
        mountpoint -q /run/whombat-factory || { echo "factory medium not mountable" >&2; exit 1; }
        trap 'sync; umount /run/whombat-factory || true' EXIT
        log=/run/whombat-factory/provision-$(date -u +%Y%m%dT%H%M%SZ).log
        ${cfg.package}/bin/whombat-provision station --medium /run/whombat-factory --persist ${p} 2>&1 | tee "$log"
        rel=$(jq -r '.factoryRelease // empty' /run/whombat-factory/station.json)
        seed=$(jq -r 'if .seedHelper == false then "no" else "yes" end' /run/whombat-factory/station.json)
        ${recordFactoryTuple}
      '';
    };

    environment.etc."whombat/self-provision.json" = lib.mkIf cfg.selfRegister {
      source = selfSettings;
    };

    # The manager writes the request when control retired this appliance while it was never claimed (never on a
    # community box: no control retires it).
    systemd.paths.whombat-self-reregister = lib.mkIf (cfg.selfRegister && !community) {
      description = "Watch for the manager's re-registration request";
      wantedBy = [ "multi-user.target" ];
      pathConfig = {
        PathExists = reregisterRequest;
        Unit = "whombat-self-provision.service";
      };
    };

    systemd.services.whombat-self-provision = lib.mkIf cfg.selfRegister {
      description =
        if community then
          "Provision this community appliance (its own identity)"
        else
          "Provision this self-installed appliance (self-registration with control)";
      wantedBy = [ "multi-user.target" ];
      # A factory medium provisions first when both are present; whichever wrote device.json wins, and the
      # other's ConditionPathExists skips it.
      after = [
        "whombat-persist.target"
        "network-online.target"
        "whombat-tpm-seal.service"
        "whombat-factory-provision.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "whombat-persist.target" ];
      unitConfig = {
        # Unprovisioned, or the manager asked for new keys, or the manager's journal holds no factory tuple yet (NX-446;
        # either suffices).
        ConditionPathExists = [
          "|!${deviceFile}"
          "|${reregisterRequest}"
          "|!${journal}/journal.a.json"
          "|!${journal}/journal.b.json"
        ];
        # Control unreachable or its per-address budget spent: retry with a growing delay, forever.
        StartLimitIntervalSec = 0;
      };
      path = [
        pkgs.coreutils
        pkgs.curl
        pkgs.jq
        pkgs.util-linux
        config.systemd.package
      ];
      serviceConfig = {
        Type = "oneshot";
        Restart = "on-failure";
        RestartSec = "2min";
        RestartSteps = 5;
        RestartMaxDelaySec = "1h";
        PrivateTmp = true;
      };
      script = ''
        set -euo pipefail
        log=/dev/null
        ${startProblemFn}
        req=${reregisterRequest}
        rel=${lib.escapeShellArg (if cfg.selfFactoryRelease == null then "" else cfg.selfFactoryRelease)}
        seed=${if cfg.selfSeedHelper then "yes" else "no"}
        if [ -e ${deviceFile} ] && [ ! -e "$req" ]; then
          # NX-446: the identity is made but the factory tuple isn't recorded (the update repository was out of reach
          # at the first start: no network yet, a Wi-Fi box). Record it now; a failure retries with the unit's delay.
          if [ -n "$rel" ] && [ ! -e ${journal}/journal.a.json ] && [ ! -e ${journal}/journal.b.json ]; then
            echo "the factory release $rel isn't recorded yet: recording it" >&2
            ${recordFactoryTuple}
          fi
          exit 0 # a factory medium won meanwhile, or nothing to do
        fi
        if [ -e ${deviceFile} ]; then
          # MG-30/NX-35: control retired this never-claimed appliance. Only when the runtime itself says it
          # isn't claimed (asked as the manager's user, the one the admin socket answers) — anything else
          # drops the request and leaves the appliance as it is.
          if ! facts=$(runuser -u whombat-manager -- curl -sf --max-time 10 --unix-socket /run/whombat/admin.sock http://runtime/facts); then
            echo "the runtime doesn't answer; trying again later" >&2
            exit 1
          fi
          if [ "$(jq -r '.claimed' <<<"$facts")" != false ]; then
            echo "the runtime is claimed (or says nothing clear): not registering it again" >&2
            rm -f "$req"
            exit 0
          fi
          systemctl stop whombat-manager.service whombat-runtime.target
          rc=0
          ${cfg.package}/bin/whombat-provision self --config /etc/whombat/self-provision.json --persist ${p} \
            --reregister "$req" --manager-claim-state ${p}/manager/journal/claim-state.json || rc=$?
          if [ "$rc" = 0 ] || [ "$rc" = 3 ]; then rm -f "$req"; fi
          systemctl --no-block start ${startProvisioned}
          [ "$rc" = 3 ] && exit 0
          exit "$rc"
        fi
        if ! ${cfg.package}/bin/whombat-provision self --config /etc/whombat/self-provision.json --persist ${p}; then
          start_problem failed
          exit 1
        fi
        ${recordFactoryTuple}
      '';
    };

    # PI-19, NX-90: a disk recovery key an earlier image (PI-04) left for the console and nobody confirmed goes, with its
    # hash: this image shows none, so it must not gate the recovery menu. A confirmed key (no pending file) stays.
    systemd.services.whombat-recovery-key-drop = lib.mkIf cfg.selfRegister {
      description = "Remove a disk recovery key that was never confirmed at the console";
      wantedBy = [ "multi-user.target" ];
      after = [ "whombat-persist.target" ];
      requires = [ "whombat-persist.target" ];
      unitConfig.ConditionPathExists = pendingKey;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${cfg.package}/bin/whombat-provision recovery-key drop-pending --persist ${p}";
        PrivateNetwork = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        # The pending file, its directory (removed when empty) and the hash.
        ReadWritePaths = [ p ];
        CapabilityBoundingSet = [ "CAP_DAC_OVERRIDE" ];
        UMask = "0077";
      };
    };

    assertions = [
      {
        # PI-10, PI-18: self-installation in prod only on the self-installed platform (a dedicated machine or a VM
        # installed from the ISO, host-encrypted storage). The factory platform is provisioned by the factory.
        assertion = !(cfg.selfRegister && config.whombat.environment == "prod") || config.whombat.platform == "self-installed";
        message = "whombat.provisioning.selfRegister in prod needs whombat.platform = \"self-installed\" (PI-02, PI-18)";
      }
    ];

    # Nothing that needs an identity starts before provisioning.
    systemd.services.whombat-server.unitConfig.ConditionPathExists = deviceFile;
    systemd.services.whombat-runner.unitConfig.ConditionPathExists = deviceFile;
    systemd.services.whombat-manager.unitConfig.ConditionPathExists = deviceFile;
    systemd.services.whombat-update-helper = lib.mkIf (config.whombat.helper.package != null) {
      unitConfig.ConditionPathExists = deviceFile;
    };
  };
}
