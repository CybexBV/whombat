# The installer's boot menu in Whombat's own look: the ISO module's NixOS logo and lavender theme gave way to Whombat's
# logo on the console's dark ground, in the UEFI menu (a GRUB theme of its own) and the BIOS one (syslinux's splash and
# colours). Only the installer ISO; the installed appliance boots with systemd-boot and shows no menu unless asked.
{ pkgs, lib, ... }:
let
  # The brand's logo for dark grounds, from packages/brand (only this file is copied into the store).
  logo = ../../../packages/brand/assets/svg/whombat-logo-horizontal-paper.svg;
  # The console's dark theme (packages/tokens): ground, text, quiet text, the brand's light accent.
  night = "#1c1815";
  ink = "#f1ebe3";
  ink2 = "#d8cfc4";
  mut = "#a0958a";
  accent = "#d2b49a";
  # The logo's own proportions (its viewBox, 582.8 × 112.5).
  logoWidth = h: builtins.floor (h * 582.8 / 112.5 + 0.5);
  efiLogoHeight = 64;
  biosLogoHeight = 48;

  # GRUB draws text only in its own bitmap fonts: DejaVu Sans, made at the two sizes the theme uses.
  font = "${pkgs.dejavu_fonts}/share/fonts/truetype/DejaVuSans.ttf";

  theme = ''
    # Whombat's boot menu (nix/profiles/installer-boot-look.nix).
    title-text: ""
    desktop-color: "${night}"
    # GRUB wants a desktop image with a theme; a plain one, stretched.
    desktop-image: "background.png"
    desktop-image-scale-method: "stretch"
    message-font: "DejaVu Sans Regular 16"
    message-color: "${ink2}"

    + image {
      left = 50%-${toString (logoWidth efiLogoHeight / 2)}
      top = 10%
      width = ${toString (logoWidth efiLogoHeight)}
      height = ${toString efiLogoHeight}
      file = "logo.png"
    }

    + boot_menu {
      left = 50%-320
      top = 10%+${toString efiLogoHeight}+8%
      width = 640
      height = 50%
      item_font = "DejaVu Sans Regular 24"
      selected_item_font = "DejaVu Sans Regular 24"
      item_color = "${ink2}"
      selected_item_color = "${night}"
      item_height = 52
      item_padding = 0
      item_spacing = 8
      item_icon_space = 0
      icon_width = 0
      icon_height = 0
      # The bar's side pieces give the text its inset; the entries that aren't selected have clear ones of the same width,
      # so their text doesn't move.
      item_pixmap_style = "item_*.png"
      selected_item_pixmap_style = "select_*.png"
      scrollbar = false
    }

    + label {
      id = "__timeout__"
      left = 50%-320
      top = 90%-24
      width = 640
      height = 24
      align = "center"
      font = "DejaVu Sans Regular 16"
      color = "${mut}"
      text = "Starting in %d s"
    }
  '';

  grubTheme =
    pkgs.runCommand "whombat-installer-grub-theme"
      {
        nativeBuildInputs = [
          pkgs.librsvg
          pkgs.buildPackages.grub2
        ];
        inherit theme;
        passAsFile = [ "theme" ];
      }
      ''
        mkdir -p $out
        cp "$themePath" $out/theme.txt
        rsvg-convert --height=${toString efiLogoHeight} --output=$out/logo.png ${logo}
        # One colour each: the ground, stretched; the selected entry's bar (its middle and its 20-px sides); clear sides
        # of the same width for the others.
        block() { printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="8"><rect width="%s" height="8" fill="%s" fill-opacity="%s"/></svg>' "$1" "$1" "$2" "$3" > block.svg; rsvg-convert --output="$4" block.svg; }
        block 8 "${night}" 1 $out/background.png
        block 8 "${accent}" 1 $out/select_c.png
        block 20 "${accent}" 1 $out/select_w.png
        block 20 "${accent}" 1 $out/select_e.png
        block 8 "${night}" 0 $out/item_c.png
        block 20 "${night}" 0 $out/item_w.png
        block 20 "${night}" 0 $out/item_e.png
        grub-mkfont --size=24 --output=$out/dejavu-sans-24.pf2 ${font}
        grub-mkfont --size=16 --output=$out/dejavu-sans-16.pf2 ${font}
      '';

  # syslinux's menu (BIOS) draws on an image of its own resolution: the logo on the dark ground, the menu below it.
  biosSplash =
    pkgs.runCommand "whombat-installer-bios-splash.png" { nativeBuildInputs = [ pkgs.librsvg ]; }
      ''
        cp ${logo} logo.svg
        w=${toString (logoWidth biosLogoHeight)}
        cat > splash.svg <<EOF
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="600">
          <rect width="800" height="600" fill="${night}"/>
          <image xlink:href="logo.svg" x="$(( (800 - w) / 2 ))" y="56" width="$w" height="${toString biosLogoHeight}"/>
        </svg>
        EOF
        rsvg-convert --output=$out splash.svg
      '';
in
{
  isoImage.grubTheme = grubTheme;
  isoImage.splashImage = biosSplash;
  # Not shown with a theme; the same ground, should a firmware's GRUB fall back to it.
  isoImage.efiSplashImage = grubTheme + "/background.png";
  # syslinux's colours on the dark ground (ARGB): the entries in the console's text colours, the selected one on the
  # brand's accent, no title (the logo is on the splash), and the menu moved down under the logo.
  isoImage.syslinuxTheme = ''
    MENU RESOLUTION 800 600
    MENU CLEAR
    MENU ROWS 6
    MENU VSHIFT 8
    MENU CMDLINEROW -4
    MENU TIMEOUTROW -3
    MENU TABMSGROW  -2
    MENU HELPMSGROW -1
    MENU HELPMSGENDROW -1
    MENU MARGIN 24

    #                                FG:AARRGGBB  BG:AARRGGBB   shadow
    MENU COLOR BORDER       30;44      #00000000    #00000000   none
    MENU COLOR SCREEN       37;40      #FF${lib.removePrefix "#" ink2}    #00000000   none
    MENU COLOR TABMSG       31;40      #FF${lib.removePrefix "#" mut}    #00000000   none
    MENU COLOR TIMEOUT      1;37;40    #FF${lib.removePrefix "#" ink}    #00000000   none
    MENU COLOR TIMEOUT_MSG  37;40      #FF${lib.removePrefix "#" mut}    #00000000   none
    MENU COLOR CMDMARK      1;36;40    #FF${lib.removePrefix "#" mut}    #00000000   none
    MENU COLOR CMDLINE      37;40      #FF${lib.removePrefix "#" ink2}    #00000000   none
    MENU COLOR TITLE        1;36;44    #00000000    #00000000   none
    MENU COLOR UNSEL        37;44      #FF${lib.removePrefix "#" ink2}    #00000000   none
    MENU COLOR SEL          7;37;40    #FF${lib.removePrefix "#" night}    #FF${lib.removePrefix "#" accent}   none
    MENU COLOR HOTKEY       37;44      #FF${lib.removePrefix "#" ink}    #00000000   none
    MENU COLOR HOTSEL       7;37;40    #FF${lib.removePrefix "#" night}    #FF${lib.removePrefix "#" accent}   none
  '';
}
