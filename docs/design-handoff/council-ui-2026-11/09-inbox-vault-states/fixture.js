// Fixture snapshot; assistant obtained with the shared name helpers.
const FIXTURE = {
  "home": {
    "summary": {
      "needsYou": 6,
      "working": 1,
      "problems": 4,
      "worst": "bad"
    },
    "needsYou": [
      {
        "id": "ny_alert-blackbox",
        "ref": {
          "kind": "alert",
          "id": "alt_blackbox-array"
        },
        "kind": "alert",
        "severity": "bad",
        "title": "The disk array on blackbox has failed",
        "body": "Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.",
        "at": "2026-09-20T07:14:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Ask Neo",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Remind me tomorrow",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "server",
          "id": "blackbox",
          "name": "blackbox"
        },
        "nature": "problem"
      },
      {
        "id": "ny_approval-901",
        "ref": {
          "kind": "approval",
          "id": "901"
        },
        "kind": "approval",
        "severity": "warn",
        "title": "Restart arnica-prod-nest-01 on pve-02?",
        "body": "It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.",
        "at": "2026-09-23T08:12:00.000Z",
        "actions": [
          {
            "id": "now",
            "label": "Yes, do it",
            "style": "primary",
            "kind": "approve"
          },
          {
            "id": "tonight",
            "label": "Tonight",
            "style": "secondary",
            "kind": "approve_later",
            "at": "2026-09-24T01:00:00.000Z"
          },
          {
            "id": "decline",
            "label": "No",
            "style": "secondary",
            "kind": "decline"
          }
        ],
        "subject": {
          "kind": "server",
          "id": "pve-02",
          "name": "pve-02"
        },
        "approvalNumber": 901
      },
      {
        "id": "ny_skill-dvp_heat-pump",
        "ref": {
          "kind": "device_skill",
          "id": "dvp_heat-pump"
        },
        "kind": "device_skill",
        "severity": "info",
        "title": "What may I change on the heat pump?",
        "body": "I can read it now. Pick what I’m allowed to change before I switch that on.",
        "at": "2026-09-23T11:41:00.000Z",
        "actions": [
          {
            "id": "choose",
            "label": "Choose",
            "style": "primary",
            "kind": "open",
            "href": "/chats/cnv_chat-heat-pump"
          }
        ],
        "subject": {
          "kind": "device",
          "id": "con_heat-pump",
          "name": "Heat pump"
        }
      }
    ],
    "needsYouList": [
      {
        "id": "ny_alert-blackbox",
        "ref": {
          "kind": "alert",
          "id": "alt_blackbox-array"
        },
        "kind": "alert",
        "severity": "bad",
        "title": "The disk array on blackbox has failed",
        "body": "Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.",
        "at": "2026-09-20T07:14:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Ask Neo",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Remind me tomorrow",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "server",
          "id": "blackbox",
          "name": "blackbox"
        },
        "nature": "problem",
        "group": "you",
        "href": "/things/server%3Ablackbox"
      },
      {
        "id": "ny_approval-901",
        "ref": {
          "kind": "approval",
          "id": "901"
        },
        "kind": "approval",
        "severity": "warn",
        "title": "Restart arnica-prod-nest-01 on pve-02?",
        "body": "It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.",
        "at": "2026-09-23T08:12:00.000Z",
        "actions": [
          {
            "id": "now",
            "label": "Yes, do it",
            "style": "primary",
            "kind": "approve"
          },
          {
            "id": "tonight",
            "label": "Tonight",
            "style": "secondary",
            "kind": "approve_later",
            "at": "2026-09-24T01:00:00.000Z"
          },
          {
            "id": "decline",
            "label": "No",
            "style": "secondary",
            "kind": "decline"
          }
        ],
        "subject": {
          "kind": "server",
          "id": "pve-02",
          "name": "pve-02"
        },
        "approvalNumber": 901,
        "group": "you"
      },
      {
        "id": "wch_pve-01-backup",
        "ref": {
          "kind": "hint",
          "id": "hnt_pve-01-backup"
        },
        "kind": "hint",
        "severity": "warn",
        "title": "No backup of pve-01’s guests for 2 days",
        "body": "The last backup job stopped halfway. The next one runs tonight at 02:00.",
        "at": "2026-09-23T04:30:00.000Z",
        "actions": [],
        "subject": {
          "kind": "server",
          "id": "pve-01",
          "name": "pve-01"
        },
        "nature": "problem",
        "group": "you",
        "href": "/things/server%3Apve-01"
      },
      {
        "id": "wch_pve-02-hot",
        "ref": {
          "kind": "alert",
          "id": "alt_pve-02-hot"
        },
        "kind": "alert",
        "severity": "warn",
        "title": "pve-02 is running hot",
        "body": "Its processor has been above 72 °C for 17 hours. The fans are at full speed.",
        "at": "2026-09-22T19:05:00.000Z",
        "actions": [],
        "subject": {
          "kind": "server",
          "id": "pve-02",
          "name": "pve-02"
        },
        "nature": "problem",
        "group": "you",
        "href": "/things/server%3Apve-02"
      },
      {
        "id": "ny_skill-dvp_heat-pump",
        "ref": {
          "kind": "device_skill",
          "id": "dvp_heat-pump"
        },
        "kind": "device_skill",
        "severity": "info",
        "title": "What may I change on the heat pump?",
        "body": "I can read it now. Pick what I’m allowed to change before I switch that on.",
        "at": "2026-09-23T11:41:00.000Z",
        "actions": [
          {
            "id": "choose",
            "label": "Choose",
            "style": "primary",
            "kind": "open",
            "href": "/chats/cnv_chat-heat-pump"
          }
        ],
        "subject": {
          "kind": "device",
          "id": "con_heat-pump",
          "name": "Heat pump"
        },
        "group": "you"
      },
      {
        "id": "wch_hetzner-slow",
        "ref": {
          "kind": "connection",
          "id": "con_hetzner"
        },
        "kind": "connection",
        "severity": "info",
        "title": "Hetzner answered slowly",
        "body": "Its API took 9 seconds to answer twice this morning. It works again.",
        "at": "2026-09-23T05:40:00.000Z",
        "actions": [],
        "subject": {
          "kind": "connection",
          "id": "con_hetzner",
          "name": "Hetzner"
        },
        "nature": "problem",
        "group": "quiet",
        "href": "/things/connection%3Acon_hetzner",
        "state": "snoozed",
        "snoozedUntil": "2026-09-24T07:00:00.000Z"
      },
      {
        "id": "wch_pve-02-pending",
        "ref": {
          "kind": "hint",
          "id": "pve-02:guest.pending_changes:pve-02"
        },
        "kind": "hint",
        "severity": "info",
        "title": "1 guest has changes waiting for a restart",
        "body": "nextcloud (1 change). Restart it to apply them.",
        "at": "2026-09-23T04:10:00.000Z",
        "actions": [],
        "subject": {
          "kind": "server",
          "id": "pve-02",
          "name": "pve-02"
        },
        "nature": "you",
        "group": "you",
        "href": "/things/server%3Apve-02",
        "fixable": true
      },
      {
        "id": "wch_pve-01-updates",
        "ref": {
          "kind": "hint",
          "id": "pve-01:system.updates:pve-01"
        },
        "kind": "hint",
        "severity": "info",
        "title": "12 updates waiting on pve-01",
        "body": "None of them is urgent. Install them on the System tab.",
        "at": "2026-09-23T03:00:00.000Z",
        "actions": [],
        "subject": {
          "kind": "server",
          "id": "pve-01",
          "name": "pve-01"
        },
        "nature": "fyi",
        "group": "fyi",
        "href": "/things/server%3Apve-01?tab=system"
      },
      {
        "id": "wch_blackbox-plex",
        "ref": {
          "kind": "hint",
          "id": "blackbox:docker.update_available:plex"
        },
        "kind": "hint",
        "severity": "info",
        "title": "An update for Plex",
        "body": "Plex 1.41.2 is out. Update it.",
        "at": "2026-09-22T16:20:00.000Z",
        "actions": [],
        "subject": {
          "kind": "server",
          "id": "blackbox",
          "name": "blackbox"
        },
        "nature": "fyi",
        "group": "fyi",
        "href": "/things/server%3Ablackbox?guest=docker%3Aplex"
      }
    ],
    "chats": [
      {
        "conversationId": "cnv_chat-heat-pump",
        "title": "Adding your Daikin heat pump",
        "state": "working",
        "at": "2026-09-23T11:41:00.000Z",
        "progress": {
          "done": 3,
          "total": 5
        },
        "step": "Choosing what I may change"
      },
      {
        "conversationId": "cnv_dm-dusty",
        "title": "Neo",
        "state": "waiting",
        "at": "2026-09-23T08:12:00.000Z",
        "default": true
      },
      {
        "conversationId": "cnv_chat-pve-02",
        "title": "Why is pve-02 so warm?",
        "state": "recent",
        "at": "2026-09-23T09:04:00.000Z"
      },
      {
        "conversationId": "cnv_chat-customer-mail",
        "title": "Customer mail every morning",
        "state": "recent",
        "at": "2026-09-21T06:12:00.000Z"
      }
    ],
    "things": [
      {
        "id": "server:thetitan",
        "kind": "server",
        "name": "thetitan",
        "icon": "debian",
        "status": "ok",
        "line": "Debian 13 · Threadripper 9970X",
        "facts": [],
        "href": "/things/server%3Athetitan"
      },
      {
        "id": "server:pve-01",
        "kind": "server",
        "name": "pve-01",
        "icon": "proxmox",
        "status": "ok",
        "line": "Proxmox VE 9.2 · Core i9-13900H",
        "facts": [],
        "href": "/things/server%3Apve-01"
      },
      {
        "id": "server:pve-02",
        "kind": "server",
        "name": "pve-02",
        "icon": "proxmox",
        "status": "warn",
        "line": "Proxmox VE 9.2 · Ryzen AI MAX+",
        "reason": "Running warm",
        "facts": [],
        "href": "/things/server%3Apve-02"
      },
      {
        "id": "server:blackbox",
        "kind": "server",
        "name": "blackbox",
        "icon": "unraid",
        "status": "bad",
        "line": "Unraid 7.3 · Xeon W-1250",
        "reason": "Disk array failed",
        "facts": [],
        "href": "/things/server%3Ablackbox"
      },
      {
        "id": "server:the-falcon",
        "kind": "server",
        "name": "the-falcon",
        "icon": "debian",
        "status": "ok",
        "line": "Debian 13 · Ryzen 9 9950X3D",
        "facts": [],
        "href": "/things/server%3Athe-falcon"
      },
      {
        "id": "connection:con_home-assistant",
        "kind": "connection",
        "catalogId": "homeassistant",
        "name": "Home Assistant",
        "icon": "home",
        "status": "warn",
        "line": "Home Assistant 2026.10.2",
        "reason": "2 integrations not loading",
        "facts": [
          {
            "label": "Integrations",
            "value": "169 of 171"
          },
          {
            "label": "Errors today",
            "value": "38"
          },
          {
            "label": "Updates",
            "value": "2"
          }
        ],
        "href": "/things/connection%3Acon_home-assistant"
      },
      {
        "id": "device:con_heat-pump",
        "kind": "device",
        "catalogId": "device",
        "name": "Heat pump",
        "icon": "thermometer",
        "status": "learning",
        "line": "Daikin Altherma",
        "facts": [],
        "href": "/things/device%3Acon_heat-pump"
      },
      {
        "id": "connection:con_unifi",
        "kind": "connection",
        "catalogId": "unifi",
        "name": "UniFi",
        "icon": "wifi",
        "status": "warn",
        "line": "45 devices",
        "reason": "1 access point offline",
        "facts": [
          {
            "label": "Internet",
            "value": "84 / 12",
            "note": "Mbit/s"
          },
          {
            "label": "Access points",
            "value": "21 of 22",
            "note": "online"
          }
        ],
        "href": "/things/connection%3Acon_unifi"
      },
      {
        "id": "connection:con_hetzner",
        "kind": "connection",
        "catalogId": "hetzner",
        "name": "Hetzner",
        "icon": "cloud",
        "status": "ok",
        "line": "1 server",
        "facts": [],
        "href": "/things/connection%3Acon_hetzner",
        "usedAt": "2026-09-22T14:20:00.000Z"
      },
      {
        "id": "connection:con_pve-02-api",
        "kind": "connection",
        "catalogId": "proxmox",
        "name": "Proxmox VE API",
        "icon": "server",
        "status": "ok",
        "line": "pve-02",
        "facts": [
          {
            "label": "Guests",
            "value": "23"
          }
        ],
        "href": "/things/connection%3Acon_pve-02-api",
        "partOf": "server:pve-02"
      },
      {
        "id": "connection:con_mail",
        "kind": "connection",
        "catalogId": "google",
        "name": "Google",
        "icon": "google",
        "status": "ok",
        "line": "Last checked 13:55",
        "facts": [],
        "href": "/things/connection%3Acon_mail",
        "usedAt": "2026-09-23T06:00:00.000Z"
      }
    ],
    "automationsToday": [
      {
        "id": "aut_customer-mail",
        "name": "Customer mail summary",
        "state": "ran",
        "at": "2026-09-23T06:00:00.000Z"
      },
      {
        "id": "aut_night-heating",
        "name": "Night-time heating",
        "state": "scheduled",
        "at": "2026-09-23T20:00:00.000Z"
      }
    ],
    "widgets": [
      {
        "id": "wdg_heat-pump",
        "title": "Heat pump · today",
        "subtitle": "Daikin Altherma",
        "kind": "line",
        "series": [
          {
            "key": "room",
            "label": "Room",
            "unit": "°C",
            "color": 1
          },
          {
            "key": "water",
            "label": "Water to radiators",
            "unit": "°C",
            "color": 2
          },
          {
            "key": "outside",
            "label": "Outside",
            "unit": "°C",
            "color": 3
          }
        ],
        "latest": [
          {
            "key": "room",
            "value": 21,
            "unit": "°C"
          },
          {
            "key": "water",
            "value": 34,
            "unit": "°C"
          },
          {
            "key": "outside",
            "value": 9,
            "unit": "°C"
          }
        ],
        "points": [
          {
            "t": "2026-09-22T22:00:00.000Z",
            "values": {
              "room": 18.4,
              "water": 31,
              "outside": 1
            }
          },
          {
            "t": "2026-09-22T22:15:00.000Z",
            "values": {
              "room": 18.8,
              "water": 34,
              "outside": 1
            }
          },
          {
            "t": "2026-09-22T22:30:00.000Z",
            "values": {
              "room": 18.6,
              "water": 35,
              "outside": 1
            }
          },
          {
            "t": "2026-09-22T22:45:00.000Z",
            "values": {
              "room": 18.7,
              "water": 33,
              "outside": 1
            }
          },
          {
            "t": "2026-09-22T23:00:00.000Z",
            "values": {
              "room": 18.9,
              "water": 35,
              "outside": 2
            }
          },
          {
            "t": "2026-09-22T23:15:00.000Z",
            "values": {
              "room": 19,
              "water": 33,
              "outside": 2
            }
          },
          {
            "t": "2026-09-22T23:30:00.000Z",
            "values": {
              "room": 18.5,
              "water": 34,
              "outside": 2
            }
          },
          {
            "t": "2026-09-22T23:45:00.000Z",
            "values": {
              "room": 18.4,
              "water": 34,
              "outside": 1
            }
          },
          {
            "t": "2026-09-23T00:00:00.000Z",
            "values": {
              "room": 18.4,
              "water": 33,
              "outside": 2
            }
          },
          {
            "t": "2026-09-23T00:15:00.000Z",
            "values": {
              "room": 19.1,
              "water": 34,
              "outside": 3
            }
          },
          {
            "t": "2026-09-23T00:30:00.000Z",
            "values": {
              "room": 18.5,
              "water": 34,
              "outside": 3
            }
          },
          {
            "t": "2026-09-23T00:45:00.000Z",
            "values": {
              "room": 18.9,
              "water": 32,
              "outside": 4
            }
          },
          {
            "t": "2026-09-23T01:00:00.000Z",
            "values": {
              "room": 19,
              "water": 30,
              "outside": 4
            }
          },
          {
            "t": "2026-09-23T01:15:00.000Z",
            "values": {
              "room": 19.1,
              "water": 30,
              "outside": 4
            }
          },
          {
            "t": "2026-09-23T01:30:00.000Z",
            "values": {
              "room": 19.7,
              "water": 27,
              "outside": 5
            }
          },
          {
            "t": "2026-09-23T01:45:00.000Z",
            "values": {
              "room": 20.6,
              "water": 28,
              "outside": 6
            }
          },
          {
            "t": "2026-09-23T02:00:00.000Z",
            "values": {
              "room": 20.6,
              "water": 27,
              "outside": 5
            }
          },
          {
            "t": "2026-09-23T02:15:00.000Z",
            "values": {
              "room": 20.6,
              "water": 26,
              "outside": 5
            }
          },
          {
            "t": "2026-09-23T02:30:00.000Z",
            "values": {
              "room": 20.8,
              "water": 31,
              "outside": 7
            }
          },
          {
            "t": "2026-09-23T02:45:00.000Z",
            "values": {
              "room": 20.8,
              "water": 30,
              "outside": 7
            }
          },
          {
            "t": "2026-09-23T03:00:00.000Z",
            "values": {
              "room": 20.8,
              "water": 31,
              "outside": 8
            }
          },
          {
            "t": "2026-09-23T03:15:00.000Z",
            "values": {
              "room": 20.6,
              "water": 34,
              "outside": 7
            }
          },
          {
            "t": "2026-09-23T03:30:00.000Z",
            "values": {
              "room": 21.1,
              "water": 37,
              "outside": 8
            }
          },
          {
            "t": "2026-09-23T03:45:00.000Z",
            "values": {
              "room": 21.1,
              "water": 37,
              "outside": 8
            }
          },
          {
            "t": "2026-09-23T04:00:00.000Z",
            "values": {
              "room": 20.9,
              "water": 36,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T04:15:00.000Z",
            "values": {
              "room": 20.9,
              "water": 39,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T04:30:00.000Z",
            "values": {
              "room": 20.6,
              "water": 38,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T04:45:00.000Z",
            "values": {
              "room": 21.3,
              "water": 36,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T05:00:00.000Z",
            "values": {
              "room": 20.7,
              "water": 34,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T05:15:00.000Z",
            "values": {
              "room": 20.6,
              "water": 35,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T05:30:00.000Z",
            "values": {
              "room": 21.2,
              "water": 33,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T05:45:00.000Z",
            "values": {
              "room": 20.9,
              "water": 33,
              "outside": 11
            }
          },
          {
            "t": "2026-09-23T06:00:00.000Z",
            "values": {
              "room": 21.3,
              "water": 29,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T06:15:00.000Z",
            "values": {
              "room": 20.7,
              "water": 27,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T06:30:00.000Z",
            "values": {
              "room": 20.7,
              "water": 28,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T06:45:00.000Z",
            "values": {
              "room": 21.4,
              "water": 28,
              "outside": 11
            }
          },
          {
            "t": "2026-09-23T07:00:00.000Z",
            "values": {
              "room": 21.3,
              "water": 26,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T07:15:00.000Z",
            "values": {
              "room": 20.6,
              "water": 29,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T07:30:00.000Z",
            "values": {
              "room": 21.3,
              "water": 31,
              "outside": 11
            }
          },
          {
            "t": "2026-09-23T07:45:00.000Z",
            "values": {
              "room": 20.4,
              "water": 32,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T08:00:00.000Z",
            "values": {
              "room": 21,
              "water": 31,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T08:15:00.000Z",
            "values": {
              "room": 21.3,
              "water": 35,
              "outside": 10
            }
          },
          {
            "t": "2026-09-23T08:30:00.000Z",
            "values": {
              "room": 20.6,
              "water": 36,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T08:45:00.000Z",
            "values": {
              "room": 20.8,
              "water": 38,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T09:00:00.000Z",
            "values": {
              "room": 21.4,
              "water": 36,
              "outside": 9
            }
          },
          {
            "t": "2026-09-23T09:15:00.000Z",
            "values": {
              "room": 21,
              "water": 34,
              "outside": 9
            }
          }
        ],
        "refreshSec": 60,
        "updatedAt": "2026-09-23T09:22:00.000Z",
        "fromConversationId": "cnv_chat-heat-pump"
      }
    ],
    "doneRecently": [
      {
        "id": "chg_zonneplan",
        "title": "Removed 14 old Zonneplan entities from Home Assistant",
        "detail": "Home Assistant restarted afterwards",
        "at": "2026-09-23T10:15:00.000Z",
        "actor": {
          "kind": "whombat",
          "id": "prn_dusty",
          "name": "Neo"
        },
        "undo": {
          "state": "available",
          "until": "2026-09-24T10:15:00.000Z"
        },
        "link": "/chats/cnv_dm-dusty",
        "thingId": "connection:con_home-assistant"
      },
      {
        "id": "chg_nextcloud-memory",
        "title": "Gave nextcloud more memory",
        "detail": "2 → 4 GB, on pve-02",
        "at": "2026-09-23T08:12:00.000Z",
        "actor": {
          "kind": "whombat",
          "id": "prn_dusty",
          "name": "Neo"
        },
        "undo": {
          "state": "available",
          "until": "2026-09-24T08:12:00.000Z"
        },
        "link": "/things/server%3Apve-02",
        "thingId": "server:pve-02"
      },
      {
        "id": "chg_pve-01-updates",
        "title": "Installed security updates on pve-01",
        "detail": "No restart needed",
        "at": "2026-09-23T01:00:00.000Z",
        "actor": {
          "kind": "whombat",
          "id": "prn_dusty",
          "name": "Neo"
        },
        "undo": {
          "state": "none"
        },
        "thingId": "server:pve-01"
      },
      {
        "id": "chg_mail-drafts",
        "title": "Wrote replies to 3 customer emails",
        "detail": "Saved as drafts in your mailbox",
        "at": "2026-09-22T15:40:00.000Z",
        "actor": {
          "kind": "whombat",
          "id": "prn_dusty",
          "name": "Neo"
        },
        "undo": {
          "state": "none"
        },
        "link": "/chats/cnv_chat-customer-mail"
      },
      {
        "id": "chg_pve-02-backups",
        "title": "Moved pve-02’s backups to 02:00",
        "detail": "They overlapped with the nightly sync",
        "at": "2026-09-22T09:05:00.000Z",
        "actor": {
          "kind": "whombat",
          "id": "prn_dusty",
          "name": "Neo"
        },
        "undo": {
          "state": "available"
        },
        "link": "/things/server%3Apve-02",
        "thingId": "server:pve-02"
      }
    ],
    "doneToday": [
      {
        "id": "dnt_nextcloud-memory",
        "text": "Gave nextcloud more memory",
        "at": "2026-09-23T08:12:00.000Z",
        "href": "/chat?thread=msg_chat-pve-memory",
        "undo": {
          "changeId": "chg_nextcloud-memory"
        }
      },
      {
        "id": "dnt_disk-guests",
        "text": "Found which guests use the most disk",
        "at": "2026-09-23T07:40:00.000Z",
        "href": "/chat?thread=msg_chat-disk"
      },
      {
        "id": "dnt_zigbee",
        "text": "Restarted Zigbee in Home Assistant",
        "at": "2026-09-23T01:12:00.000Z",
        "fixed": true
      },
      {
        "id": "dnt_pve-01-updates",
        "text": "Installed security updates on pve-01",
        "at": "2026-09-23T01:00:00.000Z"
      }
    ],
    "generatedAt": "2026-09-23T09:22:00.000Z"
  },
  "bootstrap": {
    "burrow": {
      "id": "bur_burrow-hq",
      "name": "Burrow HQ",
      "slug": "burrow-hq",
      "timeZone": "Europe/Amsterdam",
      "agentsReachLan": true,
      "localModel": null,
      "createdAt": "2026-01-05T09:00:00.000Z"
    },
    "me": {
      "id": "prn_mara",
      "burrowId": "bur_burrow-hq",
      "name": "Mara Okafor",
      "handle": "mara",
      "publicKey": "767072372706c841f1a43976b4e3d260247ea238017ce01c09f0b519b406e47a",
      "fingerprint": "3e47 96d7",
      "createdAt": "2026-01-05T09:00:00.000Z",
      "kind": "person",
      "shortName": "Mara",
      "initials": "MO",
      "tone": "#d9c3a9",
      "title": "Engineering lead",
      "email": "mara@burrowhq.example"
    },
    "principals": [
      {
        "id": "prn_mara",
        "burrowId": "bur_burrow-hq",
        "name": "Mara Okafor",
        "handle": "mara",
        "publicKey": "767072372706c841f1a43976b4e3d260247ea238017ce01c09f0b519b406e47a",
        "fingerprint": "3e47 96d7",
        "createdAt": "2026-01-05T09:00:00.000Z",
        "kind": "person",
        "shortName": "Mara",
        "initials": "MO",
        "tone": "#d9c3a9",
        "title": "Engineering lead",
        "email": "mara@burrowhq.example"
      },
      {
        "id": "prn_dusty",
        "burrowId": "bur_burrow-hq",
        "name": "Neo",
        "handle": "neo",
        "publicKey": "4d83551084303a1081acbfce5c3134387527e2c33e0a1d296c90ca76309b2e2c",
        "fingerprint": "1035 d0ed",
        "createdAt": "2026-01-05T09:00:00.000Z",
        "kind": "agent",
        "face": "neo",
        "status": "idle",
        "doing": "",
        "runtime": {
          "provider": "claude"
        }
      },
      {
        "id": "prn_auto-assess-billing",
        "burrowId": "bur_burrow-hq",
        "name": "Assess new issues and pull requests on whombat/billing",
        "handle": "auto-assess-billing",
        "publicKey": "08489be567717c80b852946ae9bab570b68d6c9f9ac393465e755db0c93bde0b",
        "fingerprint": "a839 3e3f",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-suspected-bug",
        "burrowId": "bur_burrow-hq",
        "name": "Suspected bug",
        "handle": "auto-suspected-bug",
        "publicKey": "829524c91caf197b21849fc625fecd230a17bab79ae5c2da5b7e2a81b40dd1f4",
        "fingerprint": "84bd 19fe",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-check-infra",
        "burrowId": "bur_burrow-hq",
        "name": "Check whombat/infra",
        "handle": "auto-check-infra",
        "publicKey": "41c1ba3ccb203122e17bf818c212ddc3265d89778cddc320b174d7f315e704b5",
        "fingerprint": "1a69 f49a",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-answer-general",
        "burrowId": "bur_burrow-hq",
        "name": "Answer messages",
        "handle": "auto-answer-general",
        "publicKey": "ea4d6d1c6009c899c8f03de99ca04ab204a13ac1cfc326d339b5f67c047f8ada",
        "fingerprint": "3855 2e20",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-fix-web",
        "burrowId": "bur_burrow-hq",
        "name": "Assess and fix new issues on whombat/web",
        "handle": "auto-fix-web",
        "publicKey": "e1f08bc21b7c466e9008501a55caddd7ec9a4e82825d7df0f54735774f0e6f90",
        "fingerprint": "0250 104e",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-tracker-dev",
        "burrowId": "bur_burrow-hq",
        "name": "Assess new reports in Acme dev",
        "handle": "auto-tracker-dev",
        "publicKey": "569748b815c5cc0e559e0a78af5c729c6c9a1cb7b189c239f75930fca71aa5b1",
        "fingerprint": "1dc1 abeb",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-fix-docs",
        "burrowId": "bur_burrow-hq",
        "name": "Assess and fix new issues on whombat/docs",
        "handle": "auto-fix-docs",
        "publicKey": "f24aa7ab0a69974c9ff0b88768ba949a420f9a2016ade4a563ac7a0009483630",
        "fingerprint": "0b58 59da",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-web-prs",
        "burrowId": "bur_burrow-hq",
        "name": "New pull requests on whombat/web",
        "handle": "auto-web-prs",
        "publicKey": "3cae891fa70fa5fe7a3562cf59c185736bb10db319ae617e664aace7206a4c53",
        "fingerprint": "9eb8 183d",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_auto-weekly-notes",
        "burrowId": "bur_burrow-hq",
        "name": "Weekly release notes",
        "handle": "auto-weekly-notes",
        "publicKey": "bd96ee39342aea269ca0e647009ee8a1629d6d36497817ad44bfeac7e9c564f3",
        "fingerprint": "5789 5a70",
        "createdAt": "2026-09-09T07:00:00.000Z",
        "kind": "system",
        "system": "automation"
      },
      {
        "id": "prn_feedback",
        "burrowId": "bur_burrow-hq",
        "name": "Feedback",
        "handle": "feedback",
        "publicKey": "4d83551084303a1081acbfce5c3134387527e2c33e0a1d296c90ca76309b2e2c",
        "fingerprint": "1035 d0ed",
        "createdAt": "2026-01-05T09:00:00.000Z",
        "kind": "agent",
        "face": "dusty",
        "status": "idle",
        "doing": "",
        "runtime": {
          "provider": "claude"
        }
      }
    ],
    "sidebar": {
      "branchRooms": [
        {
          "id": "cnv_pr482",
          "kind": "branch",
          "slug": "pr-482",
          "title": "feat/invoice-pdf",
          "link": {
            "type": "pr",
            "number": 482
          },
          "unread": 0,
          "mentions": 0,
          "prNumber": 482,
          "lastMessageAt": "2026-09-23T09:30:00.000Z",
          "branch": "feat/invoice-pdf",
          "prStatus": "changes_requested",
          "dot": "warn"
        }
      ],
      "dms": [
        {
          "id": "cnv_dm-dusty",
          "kind": "dm",
          "slug": "cnv_dm-dusty",
          "title": "Chat",
          "link": {
            "type": "dm",
            "room": "chat"
          },
          "unread": 0,
          "mentions": 0,
          "prNumber": null,
          "lastMessageAt": "2026-09-17T07:00:00.000Z"
        },
        {
          "id": "cnv_feedback-mara",
          "kind": "dm",
          "slug": "feedback-mara",
          "title": "Feedback",
          "link": {
            "type": "dm",
            "room": "feedback"
          },
          "unread": 0,
          "mentions": 0,
          "prNumber": null,
          "lastMessageAt": null
        }
      ],
      "counts": {
        "canvases": 4,
        "needsYou": 1
      }
    },
    "preferences": {
      "theme": "system",
      "timeZone": null
    },
    "serverTime": "2026-09-23T09:22:00.000Z",
    "realtime": {
      "path": "/ws?burrow=burrow-hq",
      "topics": [
        "burrow:bur_burrow-hq",
        "me:prn_mara"
      ]
    }
  },
  "inboxText": "Inbox\n\nWhat only you can decide, and what Neo is on.\n\nNeeds you\n6\nThe disk array on blackbox has failed\n\nBoth parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.\n\n3 days ago\n\nAsk Neo to handle it\nSettle\nRestart arnica-prod-nest-01 on pve-02?\n\nIt needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.\n\n10:12\n\nYes, now\nYes, tonight\nNo\nNo backup of pve-01’s guests for 2 days\n\nThe last backup job stopped halfway. The next one runs tonight at 02:00.\n\n06:30\n\nAsk Neo to handle it\nSettle\npve-02 is running hot\n\nIts processor has been above 72 °C for 17 hours. The fans are at full speed.\n\n1 day ago\n\nAsk Neo to handle it\nSettle\nWhat may I change on the heat pump?\n\nI can read it now. Pick what I’m allowed to change before I switch that on.\n\nHeat pump · 13:41\n\nChoose\n1 guest has changes waiting for a restart\n\nnextcloud (1 change). Restart it to apply them.\n\npve-02 · 06:10\n\nAsk Neo to handle it\nSettle\nHeads-ups\n2\nShow 2 heads-ups\nLater\n1\nHetzner answered slowly\n\nIts API took 9 seconds to answer twice this morning. It works again.\n\n07:40 · Until tomorrow 09:00\n\nBring it back\nSettled\n·\n0",
  "assistant": "Neo",
  "view": {
    "groups": [
      {
        "key": "you",
        "label": "Needs you",
        "rows": [
          {
            "id": "ny_alert-blackbox",
            "item": {
              "id": "ny_alert-blackbox",
              "ref": {
                "kind": "alert",
                "id": "alt_blackbox-array"
              },
              "kind": "alert",
              "severity": "bad",
              "title": "The disk array on blackbox has failed",
              "body": "Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.",
              "at": "2026-09-20T07:14:00.000Z",
              "actions": [
                {
                  "id": "look",
                  "label": "Ask Neo",
                  "style": "primary",
                  "kind": "investigate"
                },
                {
                  "id": "later",
                  "label": "Remind me tomorrow",
                  "style": "secondary",
                  "kind": "snooze"
                }
              ],
              "subject": {
                "kind": "server",
                "id": "blackbox",
                "name": "blackbox"
              },
              "nature": "problem",
              "group": "you",
              "href": "/things/server%3Ablackbox"
            },
            "group": "you",
            "glyph": "alert",
            "tone": "bad",
            "title": "The disk array on blackbox has failed",
            "body": "Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.",
            "meta": "3 days ago",
            "state": null,
            "says": null,
            "href": "/things/server%3Ablackbox",
            "buttons": [
              {
                "id": "handle",
                "kind": "handle",
                "label": "Ask Neo to handle it",
                "look": "primary",
                "more": false
              },
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "Problem: The disk array on blackbox has failed. Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now."
          },
          {
            "id": "ny_approval-901",
            "item": {
              "id": "ny_approval-901",
              "ref": {
                "kind": "approval",
                "id": "901"
              },
              "kind": "approval",
              "severity": "warn",
              "title": "Restart arnica-prod-nest-01 on pve-02?",
              "body": "It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.",
              "at": "2026-09-23T08:12:00.000Z",
              "actions": [
                {
                  "id": "now",
                  "label": "Yes, do it",
                  "style": "primary",
                  "kind": "approve"
                },
                {
                  "id": "tonight",
                  "label": "Tonight",
                  "style": "secondary",
                  "kind": "approve_later",
                  "at": "2026-09-24T01:00:00.000Z"
                },
                {
                  "id": "decline",
                  "label": "No",
                  "style": "secondary",
                  "kind": "decline"
                }
              ],
              "subject": {
                "kind": "server",
                "id": "pve-02",
                "name": "pve-02"
              },
              "approvalNumber": 901,
              "group": "you"
            },
            "group": "you",
            "glyph": "power",
            "tone": "warn",
            "title": "Restart arnica-prod-nest-01 on pve-02?",
            "body": "It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.",
            "meta": "10:12",
            "state": null,
            "says": null,
            "href": null,
            "buttons": [
              {
                "id": "now",
                "kind": "action",
                "label": "Yes, now",
                "look": "primary",
                "action": {
                  "id": "now",
                  "label": "Yes, now",
                  "style": "primary",
                  "kind": "approve"
                }
              },
              {
                "id": "tonight",
                "kind": "action",
                "label": "Yes, tonight",
                "look": "secondary",
                "action": {
                  "id": "tonight",
                  "label": "Yes, tonight",
                  "style": "secondary",
                  "kind": "approve_later",
                  "at": "2026-09-24T01:00:00.000Z"
                }
              },
              {
                "id": "decline",
                "kind": "action",
                "label": "No",
                "look": "secondary",
                "action": {
                  "id": "decline",
                  "label": "No",
                  "style": "secondary",
                  "kind": "decline"
                }
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "Needs a look: Restart arnica-prod-nest-01 on pve-02? It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds."
          },
          {
            "id": "wch_pve-01-backup",
            "item": {
              "id": "wch_pve-01-backup",
              "ref": {
                "kind": "hint",
                "id": "hnt_pve-01-backup"
              },
              "kind": "hint",
              "severity": "warn",
              "title": "No backup of pve-01’s guests for 2 days",
              "body": "The last backup job stopped halfway. The next one runs tonight at 02:00.",
              "at": "2026-09-23T04:30:00.000Z",
              "actions": [],
              "subject": {
                "kind": "server",
                "id": "pve-01",
                "name": "pve-01"
              },
              "nature": "problem",
              "group": "you",
              "href": "/things/server%3Apve-01"
            },
            "group": "you",
            "glyph": "server",
            "tone": "warn",
            "title": "No backup of pve-01’s guests for 2 days",
            "body": "The last backup job stopped halfway. The next one runs tonight at 02:00.",
            "meta": "06:30",
            "state": null,
            "says": null,
            "href": "/things/server%3Apve-01",
            "buttons": [
              {
                "id": "handle",
                "kind": "handle",
                "label": "Ask Neo to handle it",
                "look": "primary",
                "more": false
              },
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "Needs a look: No backup of pve-01’s guests for 2 days. The last backup job stopped halfway. The next one runs tonight at 02:00."
          },
          {
            "id": "wch_pve-02-hot",
            "item": {
              "id": "wch_pve-02-hot",
              "ref": {
                "kind": "alert",
                "id": "alt_pve-02-hot"
              },
              "kind": "alert",
              "severity": "warn",
              "title": "pve-02 is running hot",
              "body": "Its processor has been above 72 °C for 17 hours. The fans are at full speed.",
              "at": "2026-09-22T19:05:00.000Z",
              "actions": [],
              "subject": {
                "kind": "server",
                "id": "pve-02",
                "name": "pve-02"
              },
              "nature": "problem",
              "group": "you",
              "href": "/things/server%3Apve-02"
            },
            "group": "you",
            "glyph": "alert",
            "tone": "warn",
            "title": "pve-02 is running hot",
            "body": "Its processor has been above 72 °C for 17 hours. The fans are at full speed.",
            "meta": "1 day ago",
            "state": null,
            "says": null,
            "href": "/things/server%3Apve-02",
            "buttons": [
              {
                "id": "handle",
                "kind": "handle",
                "label": "Ask Neo to handle it",
                "look": "primary",
                "more": false
              },
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "Needs a look: pve-02 is running hot. Its processor has been above 72 °C for 17 hours. The fans are at full speed."
          },
          {
            "id": "ny_skill-dvp_heat-pump",
            "item": {
              "id": "ny_skill-dvp_heat-pump",
              "ref": {
                "kind": "device_skill",
                "id": "dvp_heat-pump"
              },
              "kind": "device_skill",
              "severity": "info",
              "title": "What may I change on the heat pump?",
              "body": "I can read it now. Pick what I’m allowed to change before I switch that on.",
              "at": "2026-09-23T11:41:00.000Z",
              "actions": [
                {
                  "id": "choose",
                  "label": "Choose",
                  "style": "primary",
                  "kind": "open",
                  "href": "/chats/cnv_chat-heat-pump"
                }
              ],
              "subject": {
                "kind": "device",
                "id": "con_heat-pump",
                "name": "Heat pump"
              },
              "group": "you"
            },
            "group": "you",
            "glyph": "skill",
            "tone": "info",
            "title": "What may I change on the heat pump?",
            "body": "I can read it now. Pick what I’m allowed to change before I switch that on.",
            "meta": "Heat pump · 13:41",
            "state": null,
            "says": null,
            "href": null,
            "buttons": [
              {
                "id": "choose",
                "kind": "action",
                "label": "Choose",
                "look": "primary",
                "action": {
                  "id": "choose",
                  "label": "Choose",
                  "style": "primary",
                  "kind": "open",
                  "href": "/chats/cnv_chat-heat-pump"
                }
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "What may I change on the heat pump? I can read it now. Pick what I’m allowed to change before I switch that on."
          },
          {
            "id": "wch_pve-02-pending",
            "item": {
              "id": "wch_pve-02-pending",
              "ref": {
                "kind": "hint",
                "id": "pve-02:guest.pending_changes:pve-02"
              },
              "kind": "hint",
              "severity": "info",
              "title": "1 guest has changes waiting for a restart",
              "body": "nextcloud (1 change). Restart it to apply them.",
              "at": "2026-09-23T04:10:00.000Z",
              "actions": [],
              "subject": {
                "kind": "server",
                "id": "pve-02",
                "name": "pve-02"
              },
              "nature": "you",
              "group": "you",
              "href": "/things/server%3Apve-02",
              "fixable": true
            },
            "group": "you",
            "glyph": "server",
            "tone": "info",
            "title": "1 guest has changes waiting for a restart",
            "body": "nextcloud (1 change). Restart it to apply them.",
            "meta": "pve-02 · 06:10",
            "state": null,
            "says": null,
            "href": "/things/server%3Apve-02",
            "buttons": [
              {
                "id": "askFix",
                "kind": "askFix",
                "label": "Ask Neo to handle it",
                "look": "primary"
              },
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "1 guest has changes waiting for a restart. nextcloud (1 change). Restart it to apply them."
          }
        ],
        "folded": false,
        "fold": null
      },
      {
        "key": "fyi",
        "label": "Heads-ups",
        "rows": [
          {
            "id": "wch_pve-01-updates",
            "item": {
              "id": "wch_pve-01-updates",
              "ref": {
                "kind": "hint",
                "id": "pve-01:system.updates:pve-01"
              },
              "kind": "hint",
              "severity": "info",
              "title": "12 updates waiting on pve-01",
              "body": "None of them is urgent. Install them on the System tab.",
              "at": "2026-09-23T03:00:00.000Z",
              "actions": [],
              "subject": {
                "kind": "server",
                "id": "pve-01",
                "name": "pve-01"
              },
              "nature": "fyi",
              "group": "fyi",
              "href": "/things/server%3Apve-01?tab=system"
            },
            "group": "fyi",
            "glyph": "server",
            "tone": "info",
            "title": "12 updates waiting on pve-01",
            "body": "None of them is urgent. Install them on the System tab.",
            "meta": "05:00",
            "state": null,
            "says": null,
            "href": "/things/server%3Apve-01?tab=system",
            "buttons": [
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "handle",
                "kind": "handle",
                "label": "Ask Neo to handle it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "12 updates waiting on pve-01. None of them is urgent. Install them on the System tab."
          },
          {
            "id": "wch_blackbox-plex",
            "item": {
              "id": "wch_blackbox-plex",
              "ref": {
                "kind": "hint",
                "id": "blackbox:docker.update_available:plex"
              },
              "kind": "hint",
              "severity": "info",
              "title": "An update for Plex",
              "body": "Plex 1.41.2 is out. Update it.",
              "at": "2026-09-22T16:20:00.000Z",
              "actions": [],
              "subject": {
                "kind": "server",
                "id": "blackbox",
                "name": "blackbox"
              },
              "nature": "fyi",
              "group": "fyi",
              "href": "/things/server%3Ablackbox?guest=docker%3Aplex"
            },
            "group": "fyi",
            "glyph": "server",
            "tone": "info",
            "title": "An update for Plex",
            "body": "Plex 1.41.2 is out. Update it.",
            "meta": "blackbox · 1 day ago",
            "state": null,
            "says": null,
            "href": "/things/server%3Ablackbox?guest=docker%3Aplex",
            "buttons": [
              {
                "id": "settle",
                "kind": "settle",
                "label": "Settle",
                "look": "secondary"
              },
              {
                "id": "handle",
                "kind": "handle",
                "label": "Ask Neo to handle it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              },
              {
                "id": "snooze",
                "kind": "snooze",
                "label": "Remind me tomorrow",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "An update for Plex. Plex 1.41.2 is out. Update it."
          }
        ],
        "folded": true,
        "fold": {
          "show": "Show 2 heads-ups",
          "hide": "Hide heads-ups"
        }
      },
      {
        "key": "later",
        "label": "Later",
        "rows": [
          {
            "id": "wch_hetzner-slow",
            "item": {
              "id": "wch_hetzner-slow",
              "ref": {
                "kind": "connection",
                "id": "con_hetzner"
              },
              "kind": "connection",
              "severity": "info",
              "title": "Hetzner answered slowly",
              "body": "Its API took 9 seconds to answer twice this morning. It works again.",
              "at": "2026-09-23T05:40:00.000Z",
              "actions": [],
              "subject": {
                "kind": "connection",
                "id": "con_hetzner",
                "name": "Hetzner"
              },
              "nature": "problem",
              "group": "quiet",
              "href": "/things/connection%3Acon_hetzner",
              "state": "snoozed",
              "snoozedUntil": "2026-09-24T07:00:00.000Z"
            },
            "group": "later",
            "glyph": "connection",
            "tone": "info",
            "title": "Hetzner answered slowly",
            "body": "Its API took 9 seconds to answer twice this morning. It works again.",
            "meta": "07:40",
            "state": "Until tomorrow 09:00",
            "says": null,
            "href": "/things/connection%3Acon_hetzner",
            "buttons": [
              {
                "id": "back",
                "kind": "back",
                "label": "Bring it back",
                "look": "secondary"
              },
              {
                "id": "talk",
                "kind": "talk",
                "label": "Talk to Neo about it",
                "look": "quiet",
                "more": true
              }
            ],
            "label": "Hetzner answered slowly. Its API took 9 seconds to answer twice this morning. It works again."
          }
        ],
        "folded": false,
        "fold": null
      },
      {
        "key": "settled",
        "label": "Settled",
        "rows": [],
        "folded": false,
        "fold": null
      }
    ],
    "count": 6,
    "empty": false
  },
  "vault": {
    "entries": {
      "entries": [
        {
          "id": "vlt_grafana",
          "name": "Grafana",
          "description": "Read-only dashboards for billing-api. Use the “Billing” folder.",
          "kind": "http",
          "url": "https://grafana.example.com",
          "auth": {
            "type": "bearer"
          },
          "secret": {
            "set": true,
            "setAt": "2026-09-17T14:00:00.000Z"
          },
          "totp": {
            "set": false,
            "setAt": null
          },
          "check": {
            "status": "reached",
            "summary": "Reached · answered 200",
            "checkedAt": "2026-09-23T08:20:00.000Z",
            "toolCount": null
          },
          "agentOn": true,
          "serverCount": 0,
          "moveToConnections": false,
          "lastUsedAt": "2026-09-23T07:12:00.000Z",
          "createdAt": "2026-09-17T14:00:00.000Z",
          "updatedAt": "2026-09-17T14:00:00.000Z"
        },
        {
          "id": "vlt_homeassistant",
          "name": "Home Assistant",
          "description": "Lights, heating and sensors at home. Turning things off is fine; ask me before unlocking a door.",
          "kind": "mcp",
          "url": "http://192.168.1.10:8123/api/mcp",
          "auth": {
            "type": "bearer"
          },
          "secret": {
            "set": true,
            "setAt": "2026-09-21T07:30:00.000Z"
          },
          "totp": {
            "set": false,
            "setAt": null
          },
          "check": {
            "status": "reached",
            "summary": "Reached · 5 tools",
            "checkedAt": "2026-09-23T09:19:00.000Z",
            "toolCount": 5
          },
          "agentOn": true,
          "serverCount": 0,
          "moveToConnections": true,
          "lastUsedAt": "2026-09-23T08:48:00.000Z",
          "createdAt": "2026-09-11T07:00:00.000Z",
          "updatedAt": "2026-09-21T07:30:00.000Z"
        },
        {
          "id": "vlt_printer",
          "name": "Printer admin",
          "description": "The office printer’s admin pages.",
          "kind": "http",
          "url": "http://192.168.1.20",
          "auth": {
            "type": "basic",
            "username": "admin"
          },
          "secret": {
            "set": true,
            "setAt": "2026-09-19T09:00:00.000Z"
          },
          "totp": {
            "set": false,
            "setAt": null
          },
          "check": {
            "status": "failing",
            "summary": "The server rejected the secret (401).",
            "checkedAt": "2026-09-19T09:01:00.000Z",
            "toolCount": null
          },
          "agentOn": true,
          "serverCount": 0,
          "moveToConnections": false,
          "lastUsedAt": null,
          "createdAt": "2026-09-19T09:00:00.000Z",
          "updatedAt": "2026-09-19T09:00:00.000Z"
        },
        {
          "id": "vlt_weather",
          "name": "Weather API key",
          "description": "Kept from an older Whombat.",
          "kind": "secret",
          "url": null,
          "auth": null,
          "secret": {
            "set": true,
            "setAt": "2026-09-22T08:00:00.000Z"
          },
          "totp": {
            "set": false,
            "setAt": null
          },
          "check": {
            "status": "unchecked",
            "summary": "",
            "checkedAt": null,
            "toolCount": null
          },
          "agentOn": false,
          "serverCount": 0,
          "moveToConnections": false,
          "lastUsedAt": null,
          "createdAt": "2026-09-22T08:00:00.000Z",
          "updatedAt": "2026-09-22T08:00:00.000Z"
        }
      ],
      "canAdd": true
    },
    "text": "Vault\n\nWhat Neo can sign in to when it works for you.\n\nWhen you send Neo a password in your chat, it keeps it here and hides it in your message. The AI service it runs on has still seen that one message.\n\nYOUR ENTRIES\nAdd to Vault\nGrafana\nSign-in key\ngrafana.example.com\nUsed 09:12\nHome Assistant\nConnection\n192.168.1.10:8123\nUsed 10:48\nPrinter admin\nPassword\nThe password stopped working.\nWeather API key\nSecret · nothing uses it\n\nWhich parts of your home network Neo may reach is set in Settings. See home network ranges",
    "rows": [
      {
        "id": "vlt_grafana",
        "text": "Grafana\nSign-in key\ngrafana.example.com\nUsed 09:12"
      },
      {
        "id": "vlt_homeassistant",
        "text": "Home Assistant\nConnection\n192.168.1.10:8123\nUsed 10:48"
      },
      {
        "id": "vlt_printer",
        "text": "Printer admin\nPassword\nThe password stopped working."
      },
      {
        "id": "vlt_weather",
        "text": "Weather API key\nSecret · nothing uses it"
      }
    ]
  },
  "entryText": "Grafana\nSign-in key\ngrafana.example.com\nUsed 09:12\nWHAT SHOULD NEO KNOW?\nEdit\n\nRead-only dashboards for billing-api. Use the “Billing” folder.\n\nSIGN-IN KEY\nSet · added 5 days ago\nReplace\nCONNECTION\nhttps://grafana.example.com\nSigns in with a sign-in key\nChecked 1 hour ago · Reached · answered 200\nCheck again\nNeo can use this\nNeo uses it when it works for you, never for anyone else.\nNeo can use this\nOn\nOff\nAdvanced\nRECENT USE\nNeo · in Neo’s commands for this turn · done\n09:12\nDanger"
};
