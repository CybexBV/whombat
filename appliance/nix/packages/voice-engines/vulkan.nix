# The graphics chips' Vulkan drivers for whisper.cpp (NX-472), and nothing else of mesa: no OpenGL, no gallium drivers,
# no LLVM. The appliance has no graphics drivers otherwise (NX-169: mesa with LLVM is 843 MB), and speech is the only
# thing that uses them.
#
# - RADV (AMD, `libvulkan_radeon.so`): nixpkgs' mesa recipe built for this driver alone, with ACO and without LLVM
#   (`amd-use-llvm` off); nixpkgs' own RADV links libLLVM (566 MB).
# - ANV (Intel, `libvulkan_intel.so`): taken from nixpkgs' mesa as it is. It links no LLVM; its only reference to the
#   rest of mesa is the configuration directory it would read (drirc.d), removed, so that mesa stays out of the image.
# - `share/vulkan/icd.d`: the two drivers' manifests, which the voice service names with VK_DRIVER_FILES.
{
  lib,
  stdenv,
  mesa,
  removeReferencesTo,
}:
let
  llvm = mesa.passthru.llvmPackages.libllvm;
  radv =
    (mesa.override {
      galliumDrivers = [ ];
      vulkanDrivers = [ "amd" ];
      vulkanLayers = [ ];
      eglPlatforms = [ ];
      withValgrind = false;
      enablePatentEncumberedCodecs = false;
    }).overrideAttrs
      (old: {
        pname = "mesa-radv";
        outputs = [ "out" ];
        separateDebugInfo = false;
        # nixpkgs' patch is rusticl's; the headers check is OpenGL's.
        patches = [ ];
        postPatch = "patchShebangs .";
        # Only what is named below: nixpkgs turns every optional feature on, X11's among them.
        mesonAutoFeatures = "disabled";
        mesonFlags = [
          "--sysconfdir=/etc"
          (lib.mesonOption "platforms" "")
          (lib.mesonOption "gallium-drivers" "")
          (lib.mesonOption "vulkan-drivers" "amd")
          (lib.mesonOption "vulkan-layers" "")
          (lib.mesonOption "video-codecs" "")
          (lib.mesonOption "glx" "disabled")
          (lib.mesonBool "opengl" false)
          (lib.mesonBool "amd-use-llvm" false)
          (lib.mesonBool "gallium-rusticl" false)
          (lib.mesonBool "teflon" false)
          (lib.mesonBool "build-tests" false)
          (lib.mesonEnable "llvm" false)
          (lib.mesonEnable "glvnd" false)
          (lib.mesonEnable "gbm" false)
          (lib.mesonEnable "egl" false)
          (lib.mesonEnable "gles1" false)
          (lib.mesonEnable "gles2" false)
          (lib.mesonEnable "valgrind" false)
          (lib.mesonEnable "libunwind" false)
          (lib.mesonEnable "lmsensors" false)
          (lib.mesonEnable "intel-rt" false)
          (lib.mesonEnable "microsoft-clc" false)
          (lib.mesonEnable "android-libbacktrace" false)
          (lib.mesonEnable "gallium-mediafoundation" false)
          (lib.mesonEnable "zstd" true)
          (lib.mesonEnable "xmlconfig" true)
          (lib.mesonEnable "expat" true)
          (lib.mesonEnable "shader-cache" true)
        ];
        postInstall = "";
        postFixup = ''
          find $out -type d -empty -delete
        '';
        passthru = { };
        disallowedRequisites = [ llvm ];
      });
in
stdenv.mkDerivation {
  pname = "voice-vulkan-drivers";
  inherit (mesa) version;
  dontUnpack = true;
  nativeBuildInputs = [ removeReferencesTo ];
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/share/vulkan/icd.d
    install -m755 ${mesa}/lib/libvulkan_intel.so $out/lib/
    remove-references-to -t ${mesa} $out/lib/libvulkan_intel.so
    sed 's|"library_path": *"[^"]*"|"library_path": "'$out'/lib/libvulkan_intel.so"|' \
      ${mesa}/share/vulkan/icd.d/intel_icd.x86_64.json > $out/share/vulkan/icd.d/intel_icd.x86_64.json
    cp ${radv}/share/vulkan/icd.d/radeon_icd.x86_64.json $out/share/vulkan/icd.d/
    grep -q '"library_path": "'$out'/lib/libvulkan_intel.so"' $out/share/vulkan/icd.d/intel_icd.x86_64.json
    grep -q '"library_path": "${radv}/lib/libvulkan_radeon.so"' $out/share/vulkan/icd.d/radeon_icd.x86_64.json
    runHook postInstall
  '';
  # VK_DRIVER_FILES for the voice service: both manifests.
  passthru.driverFiles =
    drivers:
    "${drivers}/share/vulkan/icd.d/radeon_icd.x86_64.json:${drivers}/share/vulkan/icd.d/intel_icd.x86_64.json";
  passthru.radv = radv;
  disallowedRequisites = [
    mesa
    llvm
  ];
  meta = {
    description = "mesa's Vulkan drivers for AMD (RADV, without LLVM) and Intel (ANV), for whisper.cpp (whombat-voice)";
    homepage = "https://mesa3d.org";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
  };
}
