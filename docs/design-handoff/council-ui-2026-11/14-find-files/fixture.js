// Fixture snapshots; assistant resolved by agentWords(theAgentOf(principals)?.name).
const DATA = {
  "assistant": "Neo",
  "clock": "2026-09-23T09:22:00.000Z",
  "query": "have we seen this invoice rounding error before?",
  "results": [
    {
      "id": "sr_thread-incidents",
      "type": "THREAD",
      "where": "fix/credit-note-vat · 3 Mar 2026",
      "authorId": "prn_mara",
      "snippet": "Credit note 4471 is a cent off. We format the amount and then round the VAT on the formatted string.",
      "citedAs": 1,
      "link": {
        "type": "pr",
        "number": 311
      },
      "createdAt": "2026-03-03T10:00:00+01:00",
      "status": null
    },
    {
      "id": "sr_patch-311",
      "type": "PATCH",
      "where": "PR #311 · merged 4 Mar",
      "authorId": "prn_mara",
      "snippet": "Round before format for credit notes. Regular invoices still use the old path.",
      "citedAs": 2,
      "link": {
        "type": "pr",
        "number": 311
      },
      "createdAt": "2026-03-04T09:30:00+01:00",
      "status": null
    },
    {
      "id": "sr_run-1882",
      "type": "RUN",
      "where": "Run #1882 · ledger reconciliation",
      "authorId": "prn_dusty",
      "snippet": "3 invoices differ from the ledger by €0,01. All three have lines with €0,005 VAT.",
      "citedAs": 3,
      "link": {
        "type": "run",
        "number": 1882
      },
      "createdAt": "2026-03-05T06:00:00+01:00",
      "status": null
    },
    {
      "id": "sr_canvas-rules-v3",
      "type": "CANVAS",
      "where": "Invoicing rules v3",
      "authorId": "prn_mara",
      "snippet": "Always round per line, half-up, before formatting. Never round the total.",
      "citedAs": null,
      "link": {
        "type": "canvas",
        "slug": "invoicing-rules-v3"
      },
      "createdAt": "2025-11-12T14:00:00+01:00",
      "status": null
    },
    {
      "id": "sr_message-pr482-mara",
      "type": "MESSAGE",
      "where": "feat/invoice-pdf · today 11:20",
      "authorId": "prn_mara",
      "snippet": "Amounts are formatted before VAT is rounded. Round first, then format, or Dutch invoices come out a cent off.",
      "citedAs": null,
      "link": {
        "type": "message",
        "in": {
          "type": "pr",
          "number": 482,
          "repo": "whombat/billing"
        },
        "messageId": "msg_pr482-mara-1120"
      },
      "createdAt": "2026-09-23T09:20:00.000Z",
      "status": null
    }
  ],
  "groups": [
    {
      "id": "you",
      "label": "You"
    },
    {
      "id": "agent",
      "label": "Neo"
    },
    {
      "id": "connections",
      "label": "Connections"
    },
    {
      "id": "appliance",
      "label": "This Whombat"
    },
    {
      "id": "advanced",
      "label": "Advanced"
    }
  ],
  "spend": {
    "generatedAt": "2026-09-23T09:22:00.000Z",
    "timeZone": "Europe/Amsterdam",
    "totals": {
      "today": {
        "turns": 5,
        "inputTokens": 82200,
        "outputTokens": 10380,
        "costUsd": 0.3737,
        "costTurns": 4,
        "unreportedTurns": 0
      },
      "week": {
        "turns": 46,
        "inputTokens": 1062974,
        "outputTokens": 132971,
        "costUsd": 4.6214,
        "costTurns": 29,
        "unreportedTurns": 1
      },
      "month": {
        "turns": 177,
        "inputTokens": 4144502,
        "outputTokens": 518983,
        "costUsd": 17.968,
        "costTurns": 111,
        "unreportedTurns": 2
      }
    },
    "plans": [
      {
        "planId": "pln_invoice-pdf",
        "title": "Invoice PDF export",
        "usedTokens": 3314805
      }
    ]
  },
  "home": {
    "summary": {
      "needsYou": 7,
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
      },
      {
        "id": "ny_look-home-assistant",
        "ref": {
          "kind": "connection",
          "id": "con_home-assistant"
        },
        "kind": "connection",
        "severity": "warn",
        "title": "Home Assistant needs a look",
        "body": "2 integrations stopped loading.",
        "at": "2026-09-23T05:12:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Not now",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "connection",
          "id": "con_home-assistant",
          "name": "Home Assistant"
        },
        "nature": "problem",
        "research": {
          "key": "connection:con_home-assistant",
          "state": "found",
          "title": "Zigbee stopped working in Home Assistant",
          "summary": "After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.",
          "fix": "Restart Zigbee",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-home-assistant",
          "at": "2026-09-23T05:14:00.000Z"
        }
      },
      {
        "id": "ny_look-unifi",
        "ref": {
          "kind": "connection",
          "id": "con_unifi"
        },
        "kind": "connection",
        "severity": "warn",
        "title": "Hallway AP is offline",
        "body": "UniFi lost it at 08:29.",
        "at": "2026-09-23T06:29:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Not now",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "connection",
          "id": "con_unifi",
          "name": "UniFi"
        },
        "nature": "problem",
        "research": {
          "key": "connection:con_unifi",
          "state": "found",
          "title": "The hallway access point is offline",
          "summary": "It doesn’t answer, not to UniFi and not on the network, so the Wi-Fi upstairs is weaker. It probably lost power or its cable; I can’t fix that from here. I’ll tell you when it’s back.",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-unifi",
          "at": "2026-09-23T06:31:00.000Z"
        }
      },
      {
        "id": "ny_look-pve-02",
        "ref": {
          "kind": "alert",
          "id": "alt_pve-02-warm"
        },
        "kind": "alert",
        "severity": "warn",
        "title": "pve-02 is running warm",
        "body": "Its processor has been at 86 °C for 20 minutes.",
        "at": "2026-09-23T08:55:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
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
          "id": "pve-02",
          "name": "pve-02"
        },
        "nature": "problem",
        "research": {
          "key": "server:pve-02",
          "state": "looking",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-02",
          "at": "2026-09-23T08:58:00.000Z"
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
        "research": {
          "key": "server:pve-01",
          "state": "found",
          "title": "pve-01 isn’t backed up, and nginx stopped",
          "summary": "None of its six machines has a backup plan, one update is waiting and nginx stopped this morning. I can sort all of it out.",
          "plan": [
            "Add the 6 machines to a nightly backup at 02:00, keeping a week",
            "Install the 1 update tonight at 03:00",
            "Restart nginx"
          ],
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-01",
          "at": "2026-09-23T07:40:00.000Z"
        },
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
        "research": {
          "key": "server:pve-02",
          "state": "looking",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-02",
          "at": "2026-09-23T08:58:00.000Z"
        },
        "group": "assistant",
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
        "research": {
          "key": "server:pve-02",
          "state": "looking",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-02",
          "at": "2026-09-23T08:58:00.000Z"
        },
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
        "research": {
          "key": "server:pve-01",
          "state": "found",
          "title": "pve-01 isn’t backed up, and nginx stopped",
          "summary": "None of its six machines has a backup plan, one update is waiting and nginx stopped this morning. I can sort all of it out.",
          "plan": [
            "Add the 6 machines to a nightly backup at 02:00, keeping a week",
            "Install the 1 update tonight at 03:00",
            "Restart nginx"
          ],
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-01",
          "at": "2026-09-23T07:40:00.000Z"
        },
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
      },
      {
        "id": "ny_look-home-assistant",
        "ref": {
          "kind": "connection",
          "id": "con_home-assistant"
        },
        "kind": "connection",
        "severity": "warn",
        "title": "Home Assistant needs a look",
        "body": "2 integrations stopped loading.",
        "at": "2026-09-23T05:12:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Not now",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "connection",
          "id": "con_home-assistant",
          "name": "Home Assistant"
        },
        "nature": "problem",
        "research": {
          "key": "connection:con_home-assistant",
          "state": "found",
          "title": "Zigbee stopped working in Home Assistant",
          "summary": "After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.",
          "fix": "Restart Zigbee",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-home-assistant",
          "at": "2026-09-23T05:14:00.000Z"
        },
        "group": "you"
      },
      {
        "id": "ny_look-unifi",
        "ref": {
          "kind": "connection",
          "id": "con_unifi"
        },
        "kind": "connection",
        "severity": "warn",
        "title": "Hallway AP is offline",
        "body": "UniFi lost it at 08:29.",
        "at": "2026-09-23T06:29:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
            "style": "primary",
            "kind": "investigate"
          },
          {
            "id": "later",
            "label": "Not now",
            "style": "secondary",
            "kind": "snooze"
          }
        ],
        "subject": {
          "kind": "connection",
          "id": "con_unifi",
          "name": "UniFi"
        },
        "nature": "problem",
        "research": {
          "key": "connection:con_unifi",
          "state": "found",
          "title": "The hallway access point is offline",
          "summary": "It doesn’t answer, not to UniFi and not on the network, so the Wi-Fi upstairs is weaker. It probably lost power or its cable; I can’t fix that from here. I’ll tell you when it’s back.",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-unifi",
          "at": "2026-09-23T06:31:00.000Z"
        },
        "group": "you"
      },
      {
        "id": "ny_look-pve-02",
        "ref": {
          "kind": "alert",
          "id": "alt_pve-02-warm"
        },
        "kind": "alert",
        "severity": "warn",
        "title": "pve-02 is running warm",
        "body": "Its processor has been at 86 °C for 20 minutes.",
        "at": "2026-09-23T08:55:00.000Z",
        "actions": [
          {
            "id": "look",
            "label": "Look into it",
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
          "id": "pve-02",
          "name": "pve-02"
        },
        "nature": "problem",
        "research": {
          "key": "server:pve-02",
          "state": "looking",
          "conversationId": "cnv_dm-dusty",
          "threadRootId": "msg_look-pve-02",
          "at": "2026-09-23T08:58:00.000Z"
        },
        "group": "assistant"
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
  }
};

DATA.nativeThings=[
  {
    "id": "server:thetitan",
    "kind": "server",
    "name": "thetitan",
    "icon": "server",
    "status": "ok",
    "line": "Running fine",
    "facts": [
      {
        "label": "CPU",
        "value": "9",
        "unit": "%"
      },
      {
        "label": "Memory",
        "value": "48",
        "unit": "%"
      },
      {
        "label": "Hottest",
        "value": "52",
        "unit": "°C"
      },
      {
        "label": "Guests",
        "value": "14",
        "note": "of 20 running"
      }
    ],
    "href": "/things/server%3Athetitan"
  },
  {
    "id": "server:pve-01",
    "kind": "server",
    "name": "pve-01",
    "icon": "server",
    "status": "ok",
    "line": "Running fine",
    "facts": [
      {
        "label": "CPU",
        "value": "21",
        "unit": "%"
      },
      {
        "label": "Memory",
        "value": "69",
        "unit": "%"
      },
      {
        "label": "Hottest",
        "value": "58",
        "unit": "°C"
      },
      {
        "label": "Guests",
        "value": "18",
        "note": "of 31 running"
      }
    ],
    "href": "/things/server%3Apve-01"
  },
  {
    "id": "server:pve-02",
    "kind": "server",
    "name": "pve-02",
    "icon": "server",
    "status": "warn",
    "line": "Running warm",
    "facts": [
      {
        "label": "CPU",
        "value": "34",
        "unit": "%"
      },
      {
        "label": "Memory",
        "value": "80",
        "unit": "%"
      },
      {
        "label": "Hottest",
        "value": "61",
        "unit": "°C"
      },
      {
        "label": "Guests",
        "value": "23",
        "note": "of 40 running"
      }
    ],
    "href": "/things/server%3Apve-02"
  },
  {
    "id": "server:blackbox",
    "kind": "server",
    "name": "blackbox",
    "icon": "server",
    "status": "bad",
    "line": "Disk array failed",
    "facts": [
      {
        "label": "CPU",
        "value": "4",
        "unit": "%"
      },
      {
        "label": "Memory",
        "value": "31",
        "unit": "%"
      },
      {
        "label": "Hottest",
        "value": "47",
        "unit": "°C"
      },
      {
        "label": "Guests",
        "value": "6",
        "note": "of 9 running"
      }
    ],
    "href": "/things/server%3Ablackbox"
  },
  {
    "id": "server:the-falcon",
    "kind": "server",
    "name": "the-falcon",
    "icon": "server",
    "status": "ok",
    "line": "Running fine",
    "facts": [
      {
        "label": "CPU",
        "value": "6",
        "unit": "%"
      },
      {
        "label": "Memory",
        "value": "39",
        "unit": "%"
      },
      {
        "label": "Hottest",
        "value": "44",
        "unit": "°C"
      },
      {
        "label": "Guests",
        "value": "5",
        "note": "of 33 running"
      }
    ],
    "href": "/things/server%3Athe-falcon"
  },
  {
    "id": "connection:con_ha",
    "kind": "connection",
    "catalogId": "homeassistant",
    "name": "Home Assistant",
    "icon": "home",
    "status": "warn",
    "line": "Home Assistant 2026.10.2",
    "facts": [
      {
        "label": "Integrations",
        "value": "169",
        "note": "of 171"
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
    "href": "/things/connection%3Acon_ha"
  },
  {
    "id": "device:con_heatpump",
    "kind": "device",
    "name": "Heat pump",
    "icon": "thermometer",
    "status": "learning",
    "line": "Neo is learning it",
    "facts": [],
    "href": "/things/device%3Acon_heatpump"
  },
  {
    "id": "connection:con_unifi",
    "kind": "connection",
    "catalogId": "unifi",
    "name": "UniFi",
    "icon": "wifi",
    "status": "ok",
    "facts": [
      {
        "label": "Devices",
        "value": "38"
      },
      {
        "label": "New",
        "value": "1"
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
    "line": "Last checked 14:00",
    "facts": [],
    "href": "/things/connection%3Acon_hetzner",
    "usedAt": "2026-09-22T14:20:00.000Z"
  },
  {
    "id": "connection:con_mail",
    "kind": "connection",
    "catalogId": "google_mail",
    "name": "Mail",
    "icon": "mail",
    "status": "ok",
    "line": "Last checked 14:00",
    "facts": [],
    "href": "/things/connection%3Acon_mail",
    "usedAt": "2026-09-23T06:00:00.000Z"
  }
];
DATA.nativeAutomation={
  "id": "aut_tracker",
  "name": "Assess and fix tracker reports",
  "lastRun": {
    "id": "arn_tracker_0",
    "number": 7,
    "status": "succeeded",
    "startedAt": "2026-09-24T09:40:00.000Z",
    "finishedAt": "2026-09-24T09:46:00.000Z",
    "waitingOn": null
  }
};
DATA.webAutomation={
  "id": "aut_assess-billing",
  "name": "Assess new issues and pull requests on whombat/billing",
  "lastRun": {
    "id": "arn_41",
    "number": 41,
    "status": "succeeded",
    "startedAt": "2026-09-23T09:02:00.000Z",
    "finishedAt": "2026-09-23T09:06:00.000Z",
    "waitingOn": null
  }
};
