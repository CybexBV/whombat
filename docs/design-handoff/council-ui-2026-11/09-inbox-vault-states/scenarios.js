// Existing fixture rows with looking research; optional fixture SSH entry. No secret values.
const SCENARIOS = {
  "handling": {
    "key": "assistant",
    "label": "Neo’s on it",
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
          "group": "assistant",
          "href": "/things/server%3Ablackbox",
          "research": {
            "key": "server:blackbox",
            "state": "looking",
            "at": "2026-09-23T09:20:00Z"
          }
        },
        "group": "assistant",
        "glyph": "alert",
        "tone": "bad",
        "title": "The disk array on blackbox has failed",
        "body": "Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.",
        "meta": "3 days ago",
        "state": null,
        "says": {
          "state": "looking",
          "title": null,
          "text": "Neo is looking into it",
          "busy": true,
          "fixed": false,
          "fix": null,
          "ignore": true,
          "ask": null
        },
        "href": "/things/server%3Ablackbox",
        "buttons": [
          {
            "id": "talk",
            "kind": "talk",
            "label": "Talk to Neo about it",
            "look": "quiet",
            "more": true
          }
        ],
        "label": "The disk array on blackbox has failed. Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now. Neo is looking into it."
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
          "group": "assistant",
          "href": "/things/server%3Apve-01",
          "research": {
            "key": "server:pve-01",
            "state": "looking",
            "at": "2026-09-23T09:20:00Z"
          }
        },
        "group": "assistant",
        "glyph": "server",
        "tone": "warn",
        "title": "No backup of pve-01’s guests for 2 days",
        "body": "The last backup job stopped halfway. The next one runs tonight at 02:00.",
        "meta": "06:30",
        "state": null,
        "says": {
          "state": "looking",
          "title": null,
          "text": "Neo is looking into it",
          "busy": true,
          "fixed": false,
          "fix": null,
          "ignore": true,
          "ask": null
        },
        "href": "/things/server%3Apve-01",
        "buttons": [
          {
            "id": "talk",
            "kind": "talk",
            "label": "Talk to Neo about it",
            "look": "quiet",
            "more": true
          }
        ],
        "label": "No backup of pve-01’s guests for 2 days. The last backup job stopped halfway. The next one runs tonight at 02:00. Neo is looking into it."
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
          "group": "assistant",
          "href": "/things/server%3Apve-02",
          "research": {
            "key": "server:pve-02",
            "state": "looking",
            "at": "2026-09-23T09:20:00Z"
          }
        },
        "group": "assistant",
        "glyph": "alert",
        "tone": "warn",
        "title": "pve-02 is running hot",
        "body": "Its processor has been above 72 °C for 17 hours. The fans are at full speed.",
        "meta": "1 day ago",
        "state": null,
        "says": {
          "state": "looking",
          "title": null,
          "text": "Neo is looking into it",
          "busy": true,
          "fixed": false,
          "fix": null,
          "ignore": true,
          "ask": null
        },
        "href": "/things/server%3Apve-02",
        "buttons": [
          {
            "id": "talk",
            "kind": "talk",
            "label": "Talk to Neo about it",
            "look": "quiet",
            "more": true
          }
        ],
        "label": "pve-02 is running hot. Its processor has been above 72 °C for 17 hours. The fans are at full speed. Neo is looking into it."
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
          "group": "assistant",
          "href": "/things/server%3Apve-02",
          "fixable": true,
          "research": {
            "key": "server:pve-02",
            "state": "looking",
            "at": "2026-09-23T09:20:00Z"
          }
        },
        "group": "assistant",
        "glyph": "server",
        "tone": "info",
        "title": "1 guest has changes waiting for a restart",
        "body": "nextcloud (1 change). Restart it to apply them.",
        "meta": "pve-02 · 06:10",
        "state": null,
        "says": {
          "state": "looking",
          "title": null,
          "text": "Neo is looking into it",
          "busy": true,
          "fixed": false,
          "fix": null,
          "ignore": true,
          "ask": null
        },
        "href": "/things/server%3Apve-02",
        "buttons": [
          {
            "id": "talk",
            "kind": "talk",
            "label": "Talk to Neo about it",
            "look": "quiet",
            "more": true
          }
        ],
        "label": "1 guest has changes waiting for a restart. nextcloud (1 change). Restart it to apply them. Neo is looking into it."
      }
    ],
    "folded": false,
    "fold": null
  },
  "ssh": {
    "id": "vlt_deploykey",
    "name": "Deploy key",
    "description": "Our web servers. Restarting services is fine; ask me before deleting anything.",
    "kind": "ssh",
    "url": null,
    "auth": {
      "type": "ssh_key",
      "keyType": "ed25519",
      "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5",
      "fingerprint": "SHA256:zibNZfkJQ795P2dUA9+2CmiONZBYBhGqzBdZj+lYkxY",
      "origin": "generated"
    },
    "secret": {
      "set": true,
      "setAt": "2026-09-18T06:30:00.000Z"
    },
    "totp": {
      "set": false,
      "setAt": null
    },
    "check": {
      "status": "reached",
      "summary": "Signed in to 1 of 2 servers",
      "checkedAt": "2026-09-23T07:40:00.000Z",
      "toolCount": null
    },
    "agentOn": true,
    "serverCount": 2,
    "moveToConnections": false,
    "lastUsedAt": "2026-09-23T08:05:00.000Z",
    "createdAt": "2026-09-18T06:30:00.000Z",
    "updatedAt": "2026-09-23T07:40:00.000Z",
    "tools": [],
    "toolsIgnored": 0,
    "key": {
      "givenAt": "2026-09-18T06:40:00.000Z",
      "servers": [
        "vss_web1"
      ],
      "envName": null
    },
    "recentUses": [
      {
        "id": "vlu_ssh1",
        "entryId": "vlt_deploykey",
        "agentId": "prn_dusty",
        "requesterId": "prn_mara",
        "dispatchId": null,
        "what": "in Dusty’s commands for this turn",
        "outcome": "done",
        "at": "2026-09-23T08:05:00.000Z",
        "eventId": null
      }
    ],
    "servers": [
      {
        "id": "vss_web1",
        "name": "web-1",
        "host": "web1.example.com",
        "port": 22,
        "username": "deploy",
        "production": false,
        "password": {
          "set": false,
          "setAt": null
        },
        "hostKey": {
          "algorithm": "ssh-ed25519",
          "fingerprint": "SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU",
          "trustedAt": "2026-09-18T06:45:00.000Z"
        },
        "seenHostKey": null,
        "check": {
          "status": "reached",
          "outcome": "reached",
          "summary": "Signed in as deploy",
          "checkedAt": "2026-09-23T07:30:00.000Z"
        },
        "createdAt": "2026-09-18T06:44:00.000Z",
        "updatedAt": "2026-09-18T06:45:00.000Z"
      },
      {
        "id": "vss_staging",
        "name": "staging",
        "host": "staging.example.com",
        "port": 22,
        "username": "deploy",
        "production": false,
        "password": {
          "set": false,
          "setAt": null
        },
        "hostKey": null,
        "seenHostKey": {
          "algorithm": "ssh-ed25519",
          "fingerprint": "SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU",
          "seenAt": "2026-09-23T07:40:00.000Z"
        },
        "check": {
          "status": "unchecked",
          "outcome": "host_key_unconfirmed",
          "summary": "Host key not confirmed yet",
          "checkedAt": "2026-09-23T07:40:00.000Z"
        },
        "createdAt": "2026-09-23T07:39:00.000Z",
        "updatedAt": "2026-09-23T07:40:00.000Z"
      }
    ]
  },
  "publicLine": "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILBmrVrARUqTYfBxNry+DHEJ+VGkRAsfW8i0duG7bwv5 whombat-zrrdkikb",
  "nativeRows": [
    {
      "id": "vlt_grafana",
      "name": "Grafana",
      "meta": "Sign-in key · grafana.example.com",
      "status": {
        "tone": "ok",
        "label": "Reached"
      },
      "lastUsed": "Used 09:12",
      "accessibilityLabel": "Grafana, Reached. Sign-in key · grafana.example.com. Used 09:12"
    },
    {
      "id": "vlt_homeassistant",
      "name": "Home Assistant",
      "meta": "Connection · 192.168.1.10:8123",
      "status": {
        "tone": "ok",
        "label": "Reached"
      },
      "lastUsed": "Used 10:48",
      "accessibilityLabel": "Home Assistant, Reached. Connection · 192.168.1.10:8123. Used 10:48"
    },
    {
      "id": "vlt_printer",
      "name": "Printer admin",
      "meta": "Password · 192.168.1.20",
      "status": {
        "tone": "bad",
        "label": "Failing"
      },
      "lastUsed": null,
      "accessibilityLabel": "Printer admin, Failing. Password · 192.168.1.20"
    },
    {
      "id": "vlt_weather",
      "name": "Weather API key",
      "meta": "Secret · nothing uses it",
      "status": {
        "tone": "neutral",
        "label": "Not checked yet"
      },
      "lastUsed": null,
      "accessibilityLabel": "Weather API key, Not checked yet. Secret · nothing uses it"
    }
  ],
  "networks": [
    {
      "id": "vln_home",
      "cidr": "192.168.1.0/24",
      "ports": "ports 80, 8123",
      "note": "Home Assistant and the printer",
      "line": "192.168.1.0/24 · ports 80, 8123 · Home Assistant and the printer"
    }
  ],
  "faceFile": "operator-head.svg"
};
