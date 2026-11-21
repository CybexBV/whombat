# The agent's tools (Whombat one-person.md OP-13, OP-16; the brief's I-1; NX-464): what the agent's commands find on
# their PATH (`WHOMBAT_AGENT_TOOLS`/bin first), the same on every box, changed only by a release. Nix stays closed to
# the agent (NX-03, NX-09): a tool that isn't here is added in a release, or run in a container (apt inside it).
# Installing into the agent's own home works: pip in a venv, npm and pnpm into the home, uv.
#
#   tools      shell basics, git, ssh, rsync, curl, wget, jq, ripgrep, fd, tree, file, zip, tmux, less, nano, vim,
#              sqlite; gcc, make, cmake, pkg-config; Node 24 with npm, npx and pnpm; Python 3 with pip, uv and the
#              document and data libraries Hermes's skills use; ffmpeg, ImageMagick, pandoc, poppler, tesseract;
#              Chromium with agent-browser; the docker CLI with compose, pointed at the agent's engine
#   libraries  the libraries manylinux wheels and downloaded Linux binaries link against, for nix-ld
#              (`WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH`, `NIX_LD_LIBRARY_PATH` in the commands)
#
# LibreOffice and TeX are not here (their sizes are in NX-464; the lead decides).
{
  lib,
  pkgs,
  buildEnv,
  makeWrapper,
  runCommand,
  # agent-browser (nix/packages/hermes, the release Whombat pins beside its Hermes plugin).
  agentBrowser,
  # The engine's socket (containers.nix): the docker CLI's default when DOCKER_HOST isn't set.
  containersSocket ? "/run/whombat-containers/podman.sock",
}:
let
  # GitPython (pygount's) on the tools' own git, not a second, minimal one (55 MB).
  python3 = pkgs.python3.override {
    packageOverrides = _: super: {
      gitpython = super.gitpython.override { pkgs = pkgs // { gitMinimal = pkgs.git; }; };
    };
  };
  python = python3.withPackages (
    ps: with ps; [
      pip
      # Documents (Hermes's docx, pptx, xlsx and pdf skills; Whombat SL-11).
      python-docx
      python-pptx
      openpyxl
      pypdf
      pdfplumber
      pypdfium2
      reportlab
      pillow
      # Data.
      numpy
      pygount
    ]
  );

  # OCR in the languages people here write (and orientation detection), not every language there is (a gigabyte).
  tesseract = pkgs.tesseract.override {
    enableLanguages = [
      "eng"
      "nld"
      "deu"
      "fra"
      "spa"
      "ita"
      "osd"
    ];
  };

  # Docker's CLI with its compose plugin; not buildx (BuildKit, which Podman's API doesn't serve: 91 MB for nothing).
  dockerClient = pkgs.docker-client.override { buildxSupport = false; };

  # The docker CLI (Docker's own, with its compose plugin) on the agent's engine (rootless Podman's Docker API): the
  # socket unless DOCKER_HOST says otherwise (the commands' wrapper sets it), and Docker's classic builder, which
  # Podman's API implements (BuildKit's isn't). Compose builds the same way.
  docker =
    runCommand "whombat-agent-docker"
      {
        nativeBuildInputs = [ makeWrapper ];
        meta.mainProgram = "docker";
      }
      ''
        mkdir -p $out/bin
        for b in docker docker-compose; do
          case $b in
            docker) src=${dockerClient}/bin/docker ;;
            docker-compose) src=${pkgs.docker-compose}/bin/docker-compose ;;
          esac
          makeWrapper $src $out/bin/$b \
            --set-default DOCKER_HOST unix://${containersSocket} \
            --set-default DOCKER_BUILDKIT 0 \
            --set-default COMPOSE_BAKE false
        done
      '';

  tools = with pkgs; [
    # Shell basics.
    bashInteractive
    coreutils
    findutils
    diffutils
    gnugrep
    gnused
    gawk
    gnutar
    gzip
    bzip2
    xz
    zstd
    zip
    unzip
    which
    patch
    file
    tree
    less
    procps
    psmisc
    tmux
    nano
    vim
    # Files, networks, data.
    git
    openssh
    rsync
    curl
    wget
    jq
    ripgrep
    fd
    sqlite-interactive
    # Building.
    gcc
    gnumake
    cmake
    pkg-config
    # Node 24 (npm, npx, corepack) and pnpm.
    nodejs_24
    pnpm
    # Python 3 and uv.
    python
    uv
    # Media and documents.
    ffmpeg-headless
    imagemagick
    pandoc
    poppler-utils
    tesseract
    # The browser.
    chromium
    agentBrowser
    # Containers.
    docker
  ];

  # nix-ld's libraries (NX-464): what manylinux2014 wheels may link against (glibc's own come with the loader) and
  # what downloaded Linux programs usually need, a headless Chromium (Playwright's) among them. Not Mesa's drivers
  # (843 MB with LLVM): libGL and libgbm only, software rendering is the programs' own.
  libraries = with pkgs; [
    stdenv.cc.cc.lib
    glibc
    zlib
    zstd
    bzip2
    xz
    libffi
    openssl
    curl
    expat
    libxml2
    libxslt
    libuuid
    libxcrypt-legacy
    ncurses
    readline
    sqlite
    icu
    attr
    acl
    libcap
    systemd
    dbus
    glib
    gmp
    krb5
    keyutils
    libsodium
    libusb1
    # Graphics and fonts.
    libGL
    libdrm
    libgbm
    libxkbcommon
    fontconfig
    freetype
    harfbuzz
    pango
    cairo
    gdk-pixbuf
    gtk3
    atk
    at-spi2-atk
    at-spi2-core
    libpng
    libjpeg
    libwebp
    libtiff
    # X11 (Chromium, Electron, Qt and Java programs load these even headless).
    libx11
    libxext
    libxrender
    libxcomposite
    libxdamage
    libxfixes
    libxrandr
    libxi
    libxtst
    libxcursor
    libxscrnsaver
    libxcb
    libxshmfence
    libice
    libsm
    libxt
    # Sound, printing and the rest a browser asks for.
    alsa-lib
    cups
    nss
    nspr
    libnotify
    libpulseaudio
  ];
in
{
  tools = buildEnv {
    name = "whombat-agent-tools";
    paths = tools;
    pathsToLink = [
      "/bin"
      "/share/man"
      "/share/terminfo"
    ];
    ignoreCollisions = true;
    meta.description = "The agent's tools (Whombat OP-13): every command's PATH on the appliance";
  };
  libraries = buildEnv {
    name = "whombat-agent-libraries";
    paths = map lib.getLib libraries;
    pathsToLink = [ "/lib" ];
    ignoreCollisions = true;
    meta.description = "Libraries for programs that weren't built for Nix (nix-ld, Whombat OP-13)";
  };
  # glibc's dynamic loader, nix-ld's NIX_LD for the agent's commands.
  loader = pkgs.stdenv.cc.bintools.dynamicLinker;
}
