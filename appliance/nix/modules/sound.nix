# The desk's sound server (Whombat docs/decisions/hardware-support.md HD-04; NX-255…NX-258): system-wide PipeWire
# with WirePlumber, its ALSA plugin and its PulseAudio socket, for the users in `whombat.sound.users` (the desk kiosk's
# user, kiosk.nix `desk`). Supersedes NX-163's “ALSA, no sound server”.
#
# - Why a sound server: a built-in microphone is often a sound card of its own (the Flow Z13's `acp-pdm-mic`, NX-179)
#   or switched on by a UCM profile (Intel SOF), and USB headsets come and go; ALSA's `default` is card 0 only.
#   WirePlumber picks the default microphone and speaker the way desktops do (its priorities, card profiles and UCM).
# - System-wide (`services.pipewire.systemWide`): the kiosk has no per-user service manager (its logind session is
#   `user-light`), so PipeWire, WirePlumber (profile `main-systemwide`: no logind, no device reservation, no portal) and
#   pipewire-pulse run as the `pipewire` user, which gets the cards through the `audio` group. They start at boot, so
#   the cards are set up before the kiosk's first sound. Clients are the `pipewire` group: `/run/pulse/native` and
#   `/run/pipewire/pipewire-0` are 0660 pipewire:pipewire.
# - WirePlumber keeps nothing (`mixin.stateless`, as `main-embedded`): every boot starts from its own choices, and a
#   new speaker starts at 70 % (WirePlumber's default is 40 %; nobody can turn the desk up yet).
# - No JACK, no cameras: WirePlumber's video monitor is off. Its Bluetooth monitor only with `bluetooth`
#   (bluetooth.nix, NX-357): the box plays to speakers and headphones (A2DP) and talks with headsets (HFP/HSP), never
#   the other way round (no phone plays through the box, BT-01); a connected speaker or headphones is where sound goes,
#   and the box's own microphone stays the one Talk hears while it has one (BT-06).
# - ALSA clients go through PipeWire too (`alsa.enable`: ALSA's `default` is PipeWire's), so nothing opens a card
#   behind the server's back. `alsactl init` on new cards stays (kiosk.nix, NX-163).
{
  config,
  lib,
  ...
}:
let
  cfg = config.whombat.sound;
  inherit (lib) mkOption types;
in
{
  options.whombat.sound = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        System-wide PipeWire with WirePlumber, ALSA and the PulseAudio socket (HD-04, NX-255). On with the desk kiosk
        (`whombat.kiosk.desk`).
      '';
    };
    users = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Users that play and record through the sound server (members of the `pipewire` group).";
    };
    pulseServer = mkOption {
      type = types.str;
      default = "unix:/run/pulse/native";
      readOnly = true;
      description = "The PulseAudio socket of pipewire-pulse (`PULSE_SERVER` of its clients).";
    };
    bluetooth = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Bluetooth speakers, headphones and headsets (Whombat BT-06, NX-357): WirePlumber's Bluetooth monitor, its sinks
        before every other speaker, a headset's microphone after the box's own. Set by bluetooth.nix.
      '';
    };
    defaultSinkVolume = mkOption {
      type = types.numbers.between 0 1;
      default = 0.7;
      description = ''
        A speaker's volume when WirePlumber sets it up (pactl's percentage scale, cubic); WirePlumber's own default is
        0.4. Nothing is kept between boots.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    services.pipewire = {
      enable = true;
      systemWide = true;
      audio.enable = true;
      alsa.enable = true;
      pulse.enable = true;
      jack.enable = false;
      wireplumber = {
        enable = true;
        extraConfig."90-whombat" = {
          "wireplumber.profiles" = {
            main-systemwide = {
              # Required: a virtual feature that only wants the Bluetooth monitors, so one that can't start doesn't
              # stop the sound (WirePlumber loads an `optional` feature only when something else pulls it in, NX-357).
              "hardware.bluetooth" = if cfg.bluetooth then "required" else "disabled";
              "hardware.video-capture" = "disabled";
              # mixin.stateless: nothing saved or restored.
              "hooks.device.profile.state" = "disabled";
              "hooks.device.routes.state" = "disabled";
              "hooks.default-nodes.state" = "disabled";
              "hooks.stream.state" = "disabled";
            }
            // lib.optionalAttrs cfg.bluetooth {
              "hooks.default-nodes.whombat-box-microphone" = "required";
            };
          };
          # WirePlumber's volumes are linear; pactl shows their cube root.
          "wireplumber.settings" = {
            "device.routes.default-sink-volume" = cfg.defaultSinkVolume * cfg.defaultSinkVolume * cfg.defaultSinkVolume;
          }
          // lib.optionalAttrs cfg.bluetooth {
            # Nothing kept (as mixin.stateless); a headset switches to its microphone while something records from it.
            "bluetooth.use-persistent-storage" = false;
            "bluetooth.autoswitch-to-headset-profile" = true;
          };
        }
        // lib.optionalAttrs cfg.bluetooth {
          # The box sends: A2DP to speakers and headphones, HFP/HSP as the gateway to headsets. No a2dp_sink, hfp_hf or
          # hsp_hs (a phone playing through the box), no LE Audio (BT “Not now”).
          "monitor.bluez.properties"."bluez5.roles" = [ "a2dp_source" "hfp_ag" "hsp_ag" ];
          # A connected speaker or headphones is the default sink, above every card (ALSA's are below 1700; BlueZ's own
          # 1010 loses to a USB card's 1109); when it goes, the box's speaker is the highest again (BT-06).
          "monitor.bluez.rules" = [
            {
              matches = [ { "node.name" = "~bluez_output.*"; } ];
              actions.update-props = {
                "priority.driver" = 3000;
                "priority.session" = 3000;
              };
            }
          ];
          "wireplumber.components" = [
            {
              name = "whombat/box-microphone-first.lua";
              type = "script/lua";
              provides = "hooks.default-nodes.whombat-box-microphone";
            }
          ];
        };
        # BT-06: a headset's microphone (its HFP source, and the source WirePlumber keeps for it, hard-coded at 2010 above
        # a card's analog microphone at 2009) is the default only while the box has no microphone of its own.
        extraScripts = lib.mkIf cfg.bluetooth {
          "whombat/box-microphone-first.lua" = ''
            SimpleEventHook {
              name = "default-nodes/whombat-box-microphone-first",
              after = { "default-nodes/find-best-default-node",
                        "default-nodes/find-selected-default-node" },
              before = { "default-nodes/apply-default-node" },
              interests = {
                EventInterest {
                  Constraint { "event.type", "=", "select-default-node" },
                  Constraint { "default-node.type", "=", "audio.source" },
                },
              },
              execute = function (event)
                local selected = event:get_data ("selected-node")
                local available = event:get_data ("available-nodes")
                available = available and available:parse ()
                if not selected or not available or not selected:find ("^bluez_") then
                  return
                end
                local best, best_prio
                for _, props in ipairs (available) do
                  local name = props ["node.name"] or ""
                  local prio = tonumber (props ["priority.session"]) or 0
                  if props ["media.class"] == "Audio/Source" and not name:find ("^bluez_") and
                      (best == nil or prio > best_prio) then
                    best, best_prio = name, prio
                  end
                end
                if best then
                  event:set_data ("selected-node", best)
                  event:set_data ("selected-node-priority", best_prio)
                end
              end
            }:register ()
          '';
        };
      };
    };
    # The cards are set up at boot, not at the first client's connection.
    systemd.services.pipewire.wantedBy = [ "multi-user.target" ];

    users.users = lib.genAttrs cfg.users (_: {
      extraGroups = [ "pipewire" ];
    });
  };
}
