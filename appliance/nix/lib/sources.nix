# What each build reads from the repository, as narrow copies with fixed names. The flake lives in appliance/; the
# runtime, the web app, the contracts and the hosts service are the folders beside it.
#
# Nix copies the whole commit into its store before it reads flake.nix, and that copy is new with every commit. A
# derivation that named it would be a new derivation with every commit too, and every box would download a "new"
# runtime for a change to a document. So nothing here names it: each source is made from a path (never from a string
# like "${root}/part", which keeps the whole tree as an input), holds only the files its build reads and has a name of
# its own. Its store path then changes only when one of those files does.
#
# Tests, stories and browser suites are left out of everything a box runs. A file a build needs and a list lacks fails
# that build at once ("cannot find …"), so a list can't be too short without anyone noticing.
{ lib, root }:
let
  rootStr = toString root;
  relOf = path: lib.removePrefix "${rootStr}/" (toString path);
  # Whether `rel` is `tree` or below it.
  within = tree: rel: rel == tree || lib.hasPrefix "${tree}/" rel;
  # Whether the directory `rel` is on the way to `target`.
  above = rel: target: lib.hasPrefix "${rel}/" target;

  # No build reads these: a checkout's products, and tests, stories and browser suites.
  skipped =
    name:
    builtins.elem name [
      "node_modules"
      "dist"
      "dist-hosted"
      "test"
      "__tests__"
    ]
    || lib.hasPrefix "e2e-" name
    || builtins.match ".*\\.(test|spec|stories)\\.tsx?" name != null;

  # A copy of the repository's root called `name`: the `files` (paths from the root), everything below the `trees`
  # that `keep` accepts, and the directories on the way to them.
  copy =
    {
      name,
      files ? [ ],
      trees ? [ ],
      keep ? (_rel: _base: true),
    }:
    builtins.path {
      inherit name;
      path = root;
      filter =
        path: type:
        let
          rel = relOf path;
          inTree = lib.any (t: within t rel) trees && keep rel (baseNameOf rel);
        in
        if type == "directory" then inTree || lib.any (above rel) (trees ++ files) else inTree || builtins.elem rel files;
    };

  dirsOf =
    dir:
    lib.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir (root + "/${dir}")));
  filesBelow = dir: map relOf (lib.filesystem.listFilesRecursive (root + "/${dir}"));
  existing = builtins.filter (f: builtins.pathExists (root + "/${f}"));

  # The pnpm workspace as `pnpm install` reads it (pnpm-workspace.yaml: apps/*, packages/*, tools/*,
  # contracts/conformance, scripts/package): its manifests, the lockfile and every workspace package's package.json.
  workspaceFiles = [
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ]
  ++ existing (
    lib.concatMap (top: map (d: "${top}/${d}/package.json") (dirsOf top)) [
      "apps"
      "packages"
      "tools"
    ]
    ++ [
      "contracts/conformance/package.json"
      "scripts/package/package.json"
    ]
  );
  patchFiles = filesBelow "patches";
  rootTsconfigs = builtins.filter (n: builtins.match "tsconfig.*\\.json" n != null) (
    lib.attrNames (builtins.readDir root)
  );

  # The packages under packages/ that only the runtime uses: the web build never reads them, so a change to them
  # doesn't rebuild the web app.
  runtimeOnly = [
    "packages/agent-runtime"
    "packages/commands"
    "packages/hermes-whombat"
    "packages/node-io"
  ];

  # A Go test file or a folder of test data: in no binary.
  goTest = name: name == "testdata" || lib.hasSuffix "_test.go" name;
  hostsModuleFiles = [
    "hosts/go.mod"
    "hosts/go.sum"
  ]
  # The hub's embedded web UI: only its Go files (the hub is built without it, and the page itself is hosts/web's own).
  ++ map (f: "hosts/web/${f}") (
    builtins.filter (n: lib.hasSuffix ".go" n) (lib.attrNames (builtins.readDir (root + "/hosts/web")))
  );
  hostsGoTrees = [
    "hosts/cmd"
    "hosts/internal"
    "hosts/packaging"
  ];

  # The appliance's Go module and the contracts' Go module it uses through a `replace` (go.mod: => ../contracts/go).
  # The contracts' own tests and test vectors are not part of any binary.
  contractsGo = lib.fileset.fileFilter (f: !(lib.hasSuffix "_test.go" f.name)) (root + "/contracts/go");
  contractsGoBuilt = lib.fileset.difference contractsGo (
    lib.fileset.maybeMissing (root + "/contracts/go/testdata")
  );
in
rec {
  inherit root workspaceFiles patchFiles;

  # What a pnpm dependency store is fetched from: the workspace as pnpm reads it and the patches, and nothing else.
  pnpm = copy {
    name = "whombat-pnpm-src";
    files = workspaceFiles ++ patchFiles;
  };
  # What decides the store's contents, for the digest of its fixed hash: the lockfile, the workspace file, the root
  # manifest and the patches. Not each package's own package.json: its version changes with every app and contracts
  # release, and a dependency can't change there without the lockfile (`--frozen-lockfile` refuses it).
  pnpmFiles = [
    "package.json"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ]
  ++ patchFiles;

  # The runtime bundle (`pnpm bundle:runtime`): the server, the runner, the commands' network daemon, the CLI, every
  # package, the bundler and its artifact scan, the patches, the licence and the notices.
  runtime = copy {
    name = "whombat-runtime-src";
    files =
      workspaceFiles
      ++ rootTsconfigs
      ++ existing [
        "LICENSE"
        "THIRD_PARTY_NOTICES.md"
        # The bundler scans what it made (the maintainers' guard list, which guards.sh finds; without one it skips).
        "scripts/scan-artifacts.sh"
        "scripts/guards.sh"
      ];
    trees = [
      "apps/server"
      "apps/runner"
      "apps/agent-net"
      "apps/cli"
      "packages"
      "scripts/package"
      "patches"
    ];
    keep = rel: base: within "patches" rel || !skipped base;
  };

  # The web app the runtime serves: apps/web with the packages it can import.
  web = copy {
    name = "whombat-web-source";
    files = workspaceFiles ++ existing [ "tsconfig.base.json" ];
    trees = [
      "apps/web"
      "tools/visual"
      "packages"
      "patches"
    ];
    keep =
      rel: base:
      within "patches" rel
      || !(
        skipped base || within "apps/web/visual" rel || lib.any (p: within p rel) runtimeOnly
      );
  };

  # Whombat's plugin for Hermes (the Hermes package copies it by content).
  hermesPlugin = root + "/packages/hermes-whombat";

  # The hosts service (Go, the module in hosts/). Three copies, so a change reaches only what compiles it:
  #   hosts         the hub and the signing tool: every Go package with the files they embed, without tests
  #   hostsAgents   the agents: the packages `whombat-agent` imports on Linux and macOS (`go list -deps
  #                 ./cmd/whombat-agent`; a package it starts to import and this list lacks fails the build with Go's
  #                 "cannot find package"), and Whombat Helper as it was built and signed on a Mac
  #   hostsModules  what `go mod vendor` reads to choose the vendored packages: every Go file, tests too
  hosts = copy {
    name = "whombat-hosts-src";
    files = hostsModuleFiles;
    trees = hostsGoTrees;
    keep = _rel: base: !goTest base;
  };
  hostsAgents = copy {
    name = "whombat-hosts-agents-src";
    files = [
      "hosts/go.mod"
      "hosts/go.sum"
    ];
    trees = map (d: "hosts/${d}") [
      "cmd/whombat-agent"
      "internal/agent"
      "internal/agentver"
      "internal/checks"
      "internal/hub/ca"
      "internal/netaddrs"
      "internal/proto"
      "internal/wire"
      "macos/helper/dist"
    ];
    keep = _rel: base: !goTest base;
  };
  hostsModules = copy {
    name = "whombat-hosts-modules-src";
    files = hostsModuleFiles;
    trees = hostsGoTrees;
  };

  # A Go build of the appliance's module: its go.mod and go.sum, the folders its packages import (`dirs`, below
  # appliance/) and the contracts' module. A build that runs its packages' tests (`tests`) gets their test files and
  # test data, and the contracts' test vectors they read (`vectors`); any other build gets neither, so a changed test
  # doesn't rebuild a program that never runs it. Unpacked, the module is in appliance/ (`modRoot`).
  applianceGo =
    {
      tests ? false,
      vectors ? [ ],
    }:
    dirs:
    let
      dir =
        d:
        if tests then
          root + "/appliance/${d}"
        else
          lib.fileset.fromSource (
            lib.sources.cleanSourceWith {
              src = root + "/appliance/${d}";
              filter = path: _type: !goTest (baseNameOf path);
            }
          );
    in
    lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions (
        [
          (root + "/appliance/go.mod")
          (root + "/appliance/go.sum")
          contractsGoBuilt
        ]
        ++ map dir dirs
        ++ map (v: root + "/contracts/go/testdata/vectors/${v}") vectors
      );
    };
  # What downloading the appliance's Go modules reads: the two modules' go.mod and go.sum, and no Go file.
  applianceGoModules = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/appliance/go.mod")
      (root + "/appliance/go.sum")
      (root + "/contracts/go/go.mod")
      (root + "/contracts/go/go.sum")
    ];
  };

  # The digest a fixed hash was taken for (appliance/scripts/ci/fixed_hashes.py computes the same without Nix): the
  # sha256 of one line per file, "<sha256>  <path from the repository's root>", sorted by path, and then one line per
  # other input, "<name>=<value>", sorted by name.
  digestOf =
    { files, params }:
    builtins.hashString "sha256" (
      lib.concatMapStrings (f: "${builtins.hashFile "sha256" (root + "/${f}")}  ${f}\n") (
        lib.sort lib.lessThan (lib.unique files)
      )
      + lib.concatStrings (lib.mapAttrsToList (n: v: "${n}=${v}\n") params)
    );

  # One entry of nix/fixed-hashes.json, for a download Nix can't predict (a pnpm store, Go modules):
  #   hash   what the download must be, and only while the entry was taken for exactly these inputs
  #   tag    the start of the inputs' digest, for the download's name: changed inputs are then another store path,
  #          which Nix must fetch and compare, where an old path of the same name would be reused unseen
  #   entry  the entry as written: with the hash, what the download is fetched with (a pnpm store's fetcher version
  #          and packages), kept in the file so the check without Nix reads the same values
  fixedEntry =
    name:
    (lib.importJSON ../fixed-hashes.json).${name}
      or (throw "appliance/nix/fixed-hashes.json has no entry ${name}");
  fixedHash =
    name: inputs:
    let
      entry = fixedEntry name;
      digest = digestOf inputs;
    in
    {
      inherit digest entry;
      tag = builtins.substring 0 12 digest;
      hash =
        if entry.digest == digest then
          entry.hash
        else
          throw "appliance/nix/fixed-hashes.json: ${name} was taken for other inputs (digest ${entry.digest} there, ${digest} now): run appliance/scripts/ci/fixed-hashes.sh --refresh ${name} and commit the file";
    };
}
