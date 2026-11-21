window.FINDABILITY_FIXTURE = {
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
  "before": [
    {
      "id": "chat",
      "name": "Chat",
      "theme": "light",
      "path": "/chat",
      "file": "before-web-chat-light.png",
      "assistant": "Neo"
    },
    {
      "id": "files",
      "name": "Files",
      "theme": "light",
      "path": "/files",
      "file": "before-web-files-light.png",
      "assistant": "Neo"
    },
    {
      "id": "vault",
      "name": "Vault",
      "theme": "light",
      "path": "/vault",
      "file": "before-web-vault-light.png",
      "assistant": "Neo"
    },
    {
      "id": "settings",
      "name": "Settings",
      "theme": "light",
      "path": "/settings",
      "file": "before-web-settings-light.png",
      "assistant": "Neo"
    },
    {
      "id": "overview",
      "name": "Overview",
      "theme": "light",
      "path": "/connections",
      "file": "before-web-overview-light.png",
      "assistant": "Neo"
    },
    {
      "id": "search",
      "name": "Search",
      "theme": "light",
      "path": "/search?q=have%20we%20seen%20this%20invoice%20rounding%20error%20before%3F",
      "file": "before-web-search-light.png",
      "assistant": "Neo"
    },
    {
      "id": "chat",
      "name": "Chat",
      "theme": "dark",
      "path": "/chat",
      "file": "before-web-chat-dark.png",
      "assistant": "Neo"
    },
    {
      "id": "files",
      "name": "Files",
      "theme": "dark",
      "path": "/files",
      "file": "before-web-files-dark.png",
      "assistant": "Neo"
    },
    {
      "id": "vault",
      "name": "Vault",
      "theme": "dark",
      "path": "/vault",
      "file": "before-web-vault-dark.png",
      "assistant": "Neo"
    },
    {
      "id": "settings",
      "name": "Settings",
      "theme": "dark",
      "path": "/settings",
      "file": "before-web-settings-dark.png",
      "assistant": "Neo"
    },
    {
      "id": "overview",
      "name": "Overview",
      "theme": "dark",
      "path": "/connections",
      "file": "before-web-overview-dark.png",
      "assistant": "Neo"
    },
    {
      "id": "search",
      "name": "Search",
      "theme": "dark",
      "path": "/search?q=have%20we%20seen%20this%20invoice%20rounding%20error%20before%3F",
      "file": "before-web-search-dark.png",
      "assistant": "Neo"
    }
  ],
  "widget": {
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
};
