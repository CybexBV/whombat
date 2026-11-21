# Hermes Agent for the runner (Whombat HE-10, HE-12; NX-430…NX-435), built from the pinned source (flake input `hermes`,
# not a flake) the way Hermes's own Nix package is (its nix/hermes-agent.nix: a uv2nix environment of its uv.lock, its
# offline assembler `scripts.build.agent`, wrappers), with only what `hermes acp` needs:
#
#   bin/hermes, bin/hermes-acp, bin/hermes-agent   wrappers of the environment's entry points (WHOMBAT_HERMES_BIN is
#                        bin/hermes; the runner starts `hermes acp`)
#   bin/agent-browser    what the plugin's browser tools drive the agent's Chromium with (Whombat HE-42, OP-13;
#                        HE-S300): the release Whombat pins (`agent-browser.json` beside its plugin), beside `hermes`,
#                        where the runner puts it on Hermes's PATH (NX-438, NX-491)
#   bin/python           the environment's interpreter with the wrappers' settings, beside `hermes`: the runner starts
#                        Hermes's `hermes-tools` MCP server with it for a Codex-mode turn with a browser (HE-S138,
#                        `hermesPython`; NX-438)
#   bin/whombat-hermes-check  the activation's check of this Hermes in a throwaway home (check.py: its version,
#                        Whombat's plugins and providers, ACP `initialize` and `session/new`); the runtime's
#                        whombat-hermes-check unit runs it, and so does the install check (Whombat HU-05; NX-484)
#   share/hermes-agent/  the install root (HERMES_INSTALL_ROOT): install-stamp.json (distribution nix, updates
#                        external: Hermes never updates itself, HE-10) and links to the bundled skills, optional
#                        skills, plugins and locale strings
#   share/hermes-resources/  those four, copied from the (patched) source so the source itself stays out of the closure
#   share/licenses/hermes-agent/LICENSE  Hermes's MIT licence (Copyright (c) 2025 Nous Research)
#
# The environment: Python 3.14 from our nixpkgs, Hermes's core dependencies plus the `acp`, `mcp` and `anthropic` extras
# (the last for its Anthropic client: a turn on the person's Anthropic key or the AI gateway, NX-469; its `all` would
# add cron, pty, uvloop, SMS, Google, web and YouTube; its full package adds messaging, voice, TTS, Modal, Daytona,
# Bedrock and the rest, its desktop, TUI and web dashboard). No Node, ripgrep, ffmpeg or clipboard tools here:
# the commands find the agent's tools (nix/packages/agent-tools, OP-13), and nothing here is a UI.
#
# Whombat's plugin (`plugin`: `packages/hermes-whombat` of the runtime source, flake input `whombat`): its pyproject
# package is installed into the environment (Hermes finds it by its `hermes_agent.plugins` entry point), and its
# `patches/*.patch` are applied to Hermes's source in name order (-p1) before the wheel is built. Its dependencies must
# be in Hermes's uv.lock (the environment has nothing else); a patch must not change pyproject.toml or uv.lock (the
# environment is resolved from the unpatched lock at evaluation). The plugin is copied by content, so a Whombat commit
# that doesn't touch it leaves this package (and so the host) unchanged.
{
  lib,
  pkgs,
  stdenv,
  autoPatchelfHook,
  makeWrapper,
  writeText,
  applyPatches,
  fetchurl,
  sqlite,
  # The pinned Hermes source (flake input `hermes`).
  src,
  # Hermes's uv2nix tool chain (flake inputs at the revisions of its flake.lock).
  uv2nix,
  pyproject-nix,
  pyproject-build-systems,
  # `packages/hermes-whombat` of the pinned Whombat, or null: Hermes alone (no plugin, no patches).
  plugin ? null,
}:
let
  # The release this source is (NX-433): the version Hermes reports comes from its install stamp, not the source.
  version = "0.23.3";
  pinnedRev = "caafe5389ae585ef77387a962aee05b1bcf17029";

  # Hermes pins its Python family in pm/lock.json; uv2nix builds against a nixpkgs interpreter of that family. Its SQLite
  # must have the WAL-reset fix, or Hermes keeps every database in rollback-journal mode (hermes_cli/sqlite_runtime.py:
  # fixed from 3.51.3, 3.50.7, 3.44.6): nixpkgs 26.05 has 3.51.2, so this Python links 3.51.3 until nixpkgs has a fixed
  # one (NX-430).
  walResetFixed =
    v:
    let
      older = lib.versionOlder v;
    in
    older "3.7.0"
    || !(older "3.51.3")
    || (!(older "3.50.7") && older "3.51.0")
    || (!(older "3.44.6") && older "3.45.0");
  sqliteFixed = sqlite.overrideAttrs (o: {
    version = "3.51.3";
    src = fetchurl {
      url = "https://sqlite.org/2026/sqlite-src-3510300.zip";
      hash = "sha256-+KZ6H1tcrnxtQvCZTKe/GkpYWIaMgq3J/BNAvtXrjNI=";
    };
    docsrc = fetchurl {
      url = "https://sqlite.org/2026/sqlite-doc-3510300.zip";
      hash = "sha256-7AU+ZqM7BHm0tMiBM67vTQIhTWPlotWe0GLK9QYeoiw=";
    };
    # 3.51.3's new walrestart.test leaves its fault hook installed, and the next test of the suite (walro.test) fails
    # in it (“fault simulator script failed”); misc1.test removes its own the same way.
    postPatch = (o.postPatch or "") + ''
      substituteInPlace test/walrestart.test --replace-fail \
        $'} {0 ok}\n\nfinish_test' $'} {0 ok}\n\nsqlite3_test_control_fault_install\nfinish_test'
    '';
    # nixpkgs names the unpacked documentation after its own version.
    postInstall =
      builtins.replaceStrings [ "sqlite-doc-3510200" ] [ "sqlite-doc-3510300" ]
        o.postInstall;
  });
  # A package set whose python314 links it: overriding the interpreter alone isn't enough, the build hooks take
  # `pythonOnBuildForHost` from the set by name and wrote the unpatched interpreter into the entry points.
  hermesPkgs =
    if walResetFixed sqlite.version then
      pkgs
    else
      pkgs.appendOverlays [
        (_: prev: { python314 = prev.python314.override { sqlite = sqliteFixed; }; })
      ];
  python = hermesPkgs.python314;
  lockedFamily =
    let
      v = (lib.importJSON "${src}/pm/lock.json").packages.python.version;
    in
    lib.versions.majorMinor (builtins.head (lib.splitString "+" v));

  pluginSrc =
    if plugin == null then
      null
    else
      builtins.path {
        path = plugin;
        name = "hermes-whombat-source";
        # A worktree's build products and caches (a `path:` input has them) stay out.
        filter =
          path: _type:
          !(
            builtins.elem (baseNameOf path) [
              "__pycache__"
              ".venv"
              ".pytest_cache"
              ".ruff_cache"
              ".mypy_cache"
              "node_modules"
              "build"
              "dist"
            ]
            || lib.hasSuffix ".egg-info" path
          );
      };
  pluginProject = pyproject-nix.lib.project.loadPyproject { projectRoot = pluginSrc; };
  # Its distribution name as the package set names it (PEP 503).
  pluginName =
    if plugin == null then
      null
    else
      pyproject-nix.lib.pypa.normalizePackageName pluginProject.pyproject.project.name;
  patchDir = "${pluginSrc}/patches";
  patches = lib.optionals (plugin != null && builtins.pathExists patchDir) (
    map (n: "${patchDir}/${n}") (
      lib.sort lib.lessThan (
        lib.attrNames (
          lib.filterAttrs (n: t: t == "regular" && lib.hasSuffix ".patch" n) (builtins.readDir patchDir)
        )
      )
    )
  );

  # The source the wheel and the resources are made of. A patch may not touch what the environment was resolved from.
  hermesSrc =
    if patches == [ ] then
      src
    else
      applyPatches {
        name = "hermes-agent-${version}-patched-source";
        inherit src patches;
        postPatch = ''
          for f in pyproject.toml uv.lock pm/lock.json; do
            cmp -s ${src}/$f $f || { echo "a Whombat patch changes $f: the environment is resolved from the unpatched one" >&2; exit 1; }
          done
        '';
      };

  workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = src; };
  environ = pyproject-nix.lib.pep508.mkEnviron python;

  pythonSet =
    (hermesPkgs.callPackage pyproject-nix.build.packages {
      inherit python;
    }).overrideScope
      (
        lib.composeManyExtensions [
          pyproject-build-systems.overlays.default
          (workspace.mkPyprojectOverlay { sourcePreference = "wheel"; })
          (
            final: prev:
            {
              hermes-agent = prev.hermes-agent.overrideAttrs (_: {
                src = hermesSrc;
                # Hermes's setup.py builds a wheel only inside its Nix build (its python.nix sets the same).
                HERMES_NIX_BUILD = "1";
              });
            }
            // lib.optionalAttrs (plugin != null) {
              ${pluginName} = final.callPackage (
                {
                  stdenv,
                  pyprojectHook,
                  resolveBuildSystem,
                }:
                stdenv.mkDerivation (
                  pyproject-nix.build.lib.renderers.mkDerivation
                    {
                      project = pluginProject;
                      inherit environ;
                    }
                    {
                      inherit pyprojectHook resolveBuildSystem;
                    }
                )
              ) { };
            }
          )
        ]
      );

  venv = pythonSet.mkVirtualEnv "hermes-agent-env" (
    {
      hermes-agent = [
        "acp"
        "mcp"
        "anthropic"
      ];
    }
    // lib.optionalAttrs (plugin != null) { ${pluginName} = [ ]; }
  );

  # Hermes's package manager runs on an environment of its own (its nix/pm-runtime.nix); the install stamp names it.
  pmRuntime = hermesPkgs.callPackage "${src}/nix/pm-runtime.nix" {
    inherit uv2nix pyproject-nix pyproject-build-systems;
  };

  dirty = patches != [ ];
  installStamp = writeText "hermes-install-stamp.json" (
    builtins.toJSON {
      schemaVersion = 2;
      commit = src.rev;
      commitDate = src.lastModified;
      branch = null;
      inherit dirty;
      builtAt = null;
      baseVersion = version;
      displayVersion = version;
      distance = 0;
      source = "nix";
      distribution = "nix";
      pmRuntime = toString pmRuntime;
      # Hermes never updates itself (HE-10): a new pin is ours (NX-433).
      updateMechanism = "external";
      payload = "bootstrap";
      tag = null;
    }
  );

  # Only the offline assembler's own files (as Hermes's package does).
  assemblerSrc = builtins.path {
    path = "${src}";
    name = "hermes-assembler";
    filter =
      path: _type:
      builtins.elem (lib.removePrefix "${src}/" path) [
        "scripts"
        "scripts/build"
        "scripts/build/agent.py"
        "scripts/build/inputs.py"
        "scripts/build/launchers.py"
      ];
  };

  # agent-browser (NX-438, NX-491): the browser tools of Whombat's plugin run it against a CDP endpoint
  # (`browser.cdp_url`, the runner's relay to the agent's Chromium, Whombat HE-42, HE-S300). The version and the npm
  # tarball's sha256 Whombat pins beside its plugin (`agent-browser.json`; its development install takes the same);
  # a Whombat from before that takes the one Hermes's own lock pinned (pm/lock.json, until Hermes 0.22.6 dropped it).
  # Its native Linux binary only (no Node, no Chromium download), linked against our glibc.
  agentBrowserPin =
    let
      pinned = "${pluginSrc}/agent-browser.json";
      hermesLock = (lib.importJSON "${src}/pm/lock.json").packages;
    in
    if pluginSrc != null && builtins.pathExists pinned then
      lib.importJSON pinned
    else
      hermesLock.agent-browser
        or (throw "no agent-browser pin: Whombat's plugin has no agent-browser.json and Hermes's lock none");
  agentBrowser = stdenv.mkDerivation {
    pname = "agent-browser";
    inherit (agentBrowserPin) version;
    src = fetchurl {
      inherit (agentBrowserPin.artifacts.any) url sha256;
    };
    sourceRoot = "package";
    nativeBuildInputs = [ autoPatchelfHook ];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      install -Dm0755 bin/agent-browser-linux-${
        if stdenv.hostPlatform.isAarch64 then "arm64" else "x64"
      } $out/bin/agent-browser
      install -Dm0644 LICENSE $out/share/licenses/agent-browser/LICENSE
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      $out/bin/agent-browser --version | grep -qxF 'agent-browser ${agentBrowserPin.version}'
    '';
    meta = {
      description = "Browser automation CLI that Whombat's browser tools drive";
      homepage = "https://github.com/vercel-labs/agent-browser";
      license = lib.licenses.asl20;
      mainProgram = "agent-browser";
    };
  };

  # Bundled with Hermes: its skills (synced into the shared skills directory by the runner, Whombat HSK-02), its
  # optional skills (the hub's `official` source owners install from in Settings, HSK-06; NX-447), its plugins (memory,
  # context engine, model providers) and its locale strings. Not its optional-mcps catalogue.
  resources = [
    "skills"
    "optional-skills"
    "plugins"
    "locales"
  ];
in
assert lib.assertMsg (src.rev == pinnedRev)
  "nix/packages/hermes: the flake input `hermes` is at ${src.rev}, but this package says ${version} is ${pinnedRev} (NX-433: bump both)";
assert lib.assertMsg (lockedFamily == python.pythonVersion)
  "nix/packages/hermes: Hermes pins Python ${lockedFamily} (pm/lock.json), nixpkgs gives ${python.pythonVersion}";
stdenv.mkDerivation {
  pname = "hermes-agent";
  version = "${version}${lib.optionalString (plugin != null) "-whombat"}";

  dontUnpack = true;
  dontBuild = true;
  # The bundled skills' scripts are copied into the profile and run as the agent's commands, with the agent's tools on
  # their PATH (`#!/usr/bin/env bash`). The wrappers have their own interpreter lines.
  dontPatchShebangs = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/hermes-resources
    ${lib.concatMapStringsSep "\n" (
      r: "cp -r ${hermesSrc}/${r} $out/share/hermes-resources/${r}"
    ) resources}
    find $out/share/hermes-resources -name __pycache__ -prune -exec rm -rf {} +
    chmod -R u+w $out/share/hermes-resources

    ${python}/bin/python3 - "$out" > "$TMPDIR/inputs.json" <<'PY'
    import json, sys

    out = sys.argv[1]
    print(json.dumps({
        "project": "${src}/pyproject.toml",
        "code": "${venv}/${python.sitePackages}",
        "repo": "share/hermes-agent",
        "placement": "references",
        "target": "linux-${if stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}",
        "python": "${venv}/bin/python3",
        "site_packages": "${venv}/${python.sitePackages}",
        "environment": "${venv}",
        "pm_runtime": "${pmRuntime}",
        "command_dir": "${venv}/bin",
        "resources": {r: f"{out}/share/hermes-resources/{r}" for r in ${builtins.toJSON resources}},
        "frontends": {},
        "ref": ${if dirty then "None" else "\"${src.rev}\""},
        "stamp": "${installStamp}",
        # Not HERMES_REVISION (Hermes's own package sets it): only its update check reads it, and without it an
        # install without a git checkout has none to check (hermes_cli/source_check.py; HE-10, NX-435).
        "env": {},
    }))
    PY

    PYTHONPATH=${assemblerSrc} ${python}/bin/python3 -m scripts.build.agent --inputs "$TMPDIR/inputs.json" --out "$out"

    # The assembler's command map: one wrapper per entry point with its environment (as Hermes's package does), and
    # HERMES_BIN for the processes Hermes starts of itself. No downloads on demand (HE-10): Hermes's package manager
    # would otherwise install an extra a feature asks for into the profile (its Docker image sets the same).
    ${python}/bin/python3 - "$out" > "$TMPDIR/wrappers.sh" <<'PY'
    import json, shlex, sys

    out = sys.argv[1]
    with open(f"{out}/command-map.json") as handle:
        description = json.load(handle)
    env = [arg for key, value in sorted(description["env"].items()) for arg in ("--set", key, value)]
    # The entry points, and the interpreter itself as bin/python (what `python -m …` of Hermes's own servers needs).
    targets = [(c["source"], c["destination"]) for c in description["commands"].values()]
    targets.append(("${venv}/bin/python3", "bin/python"))
    for source, destination in targets:
        print(shlex.join(["makeWrapper", source, f"{out}/{destination}", *env,
                          "--set", "HERMES_DISABLE_LAZY_INSTALLS", "1",
                          "--set-default", "HERMES_BIN", f"{out}/bin/hermes"]))
    PY
    source "$TMPDIR/wrappers.sh"
    ln -s ${agentBrowser}/bin/agent-browser $out/bin/agent-browser
    # The activation's check (NX-484), on the wrappers' interpreter with what it checks against.
    install -Dm0644 ${./check.py} $out/libexec/whombat-hermes-check.py
    makeWrapper $out/bin/python $out/bin/whombat-hermes-check \
      --add-flags "-I $out/libexec/whombat-hermes-check.py" \
      --set WHOMBAT_HERMES_BIN $out/bin/hermes \
      --set WHOMBAT_HERMES_CHECK_VERSION ${version} \
      --set WHOMBAT_HERMES_CHECK_PLUGIN "${if plugin == null then "" else pluginName}"
    # Hermes's MIT notice with the program (Whombat HE-63; THIRD_PARTY_NOTICES.md, /etc/whombat/).
    install -Dm0644 ${src}/LICENSE $out/share/licenses/hermes-agent/LICENSE

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME=$TMPDIR/home HERMES_HOME=$TMPDIR/hermes-home
    mkdir -p $HOME $HERMES_HOME
    # The entry points run the environment's own interpreter (one Python in the closure).
    head -1 ${venv}/bin/hermes | grep -qxF '#!${venv}/bin/python${python.pythonVersion}'
    $out/bin/hermes --version | tee version.out
    grep -q '${version}' version.out
    $out/bin/hermes acp --help > /dev/null
    $out/bin/agent-browser --version | grep -qxF 'agent-browser ${agentBrowserPin.version}'
    grep -qF 'Copyright (c) 2025 Nous Research' $out/share/licenses/hermes-agent/LICENSE
    # bin/python is the environment's, with Hermes's tools server for Codex importable.
    test "$($out/bin/python -c 'import sys; print(sys.prefix)')" = ${venv}
    $out/bin/python -c 'import agent.transports.hermes_tools_mcp_server'
    # Hermes's Anthropic client builds with lazy installs off, as in a turn on a key or the AI gateway (NX-469); without
    # the build sandbox's SSL_CERT_FILE, which names no file.
    env -u SSL_CERT_FILE $out/bin/python -c 'from agent.anthropic_adapter import build_anthropic_client as b; b("k", "http://127.0.0.1:47104/ai-gateway/claude")'
    # The ACP and MCP libraries, Anthropic's SDK (NX-469), and Whombat's plugin by its entry point.
    ${venv}/bin/python3 -I -c '
    import importlib.metadata as m, re, sqlite3, acp, mcp, anthropic, acp_adapter.entry
    from hermes_cli.sqlite_runtime import is_sqlite_wal_reset_vulnerable
    assert not is_sqlite_wal_reset_vulnerable(sqlite3.sqlite_version_info), sqlite3.sqlite_version
    plugin = ${if plugin == null then "None" else "\"${pluginName}\""}
    if plugin is not None:
        m.distribution(plugin)
        eps = [ep for ep in m.entry_points(group="hermes_agent.plugins")
               if re.sub(r"[-_.]+", "-", ep.dist.name).lower() == plugin]
        assert eps, "the Whombat plugin has no hermes_agent.plugins entry point"
        for ep in eps:
            ep.load()
        from providers import get_provider_profile
        from whombat_hermes.directsdk import GATEWAY_PROVIDER, gateway_profile
        assert get_provider_profile(GATEWAY_PROVIDER) is gateway_profile, "the native Claude gateway provider is missing"
    '
    # The activation's check as the box runs it, in its own throwaway home (NX-484): Hermes's plugin discovery, ACP
    # initialize and a session (its gateway on loopback).
    env -u SSL_CERT_FILE $out/bin/whombat-hermes-check
    runHook postInstallCheck
  '';

  # The source (patched or not) stays out of the closure: what Hermes reads at run time is in the environment and in
  # share/hermes-resources.
  disallowedReferences = [ src ] ++ lib.optional dirty hermesSrc;

  passthru = {
    inherit
      python
      venv
      pmRuntime
      patches
      pluginName
      ;
    inherit agentBrowser;
    hermesRev = src.rev;
    hermesVersion = version;
    withPlugin = plugin != null;
  };

  meta = {
    description = "Hermes Agent for the Whombat runner (ACP and MCP only)";
    homepage = "https://github.com/NousResearch/hermes-agent";
    license = lib.licenses.mit;
    mainProgram = "hermes";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
