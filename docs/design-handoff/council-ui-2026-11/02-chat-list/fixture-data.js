// Generated from the shipped fixture factories by build-data.mjs.
window.CHAT_FIXTURE = {
  "frozen": "2026-09-23T09:22:00.000Z",
  "assistant": {
    "name": "Neo",
    "Name": "Neo",
    "ask": "Ask Neo",
    "askPlaceholder": "Ask Neo to check, change or set up anything…",
    "askShort": "Ask Neo…",
    "reply": "Reply to Neo…",
    "nameHint": "One word with a capital first letter. Neo answers you in your chat and looks after your servers and connections.",
    "newFace": "Neo has a new face and way of talking.",
    "chatSub": "You and Neo · every question gets its own thread",
    "chatPlaceholder": "Ask Neo anything",
    "chatEmpty": "Ask Neo anything. Each question gets its own thread.",
    "lookingIntoIt": "Neo is looking into it",
    "feedbackSub": "Reports from your websites · Neo looks into each one"
  },
  "baseline": {
    "open": {
      "threads": [
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_care-pve-03",
          "authorId": "prn_dusty",
          "text": "pve-03 is ready. I’m working out how to look after it.",
          "subject": {
            "kind": "server",
            "id": "pve-03",
            "name": "pve-03"
          },
          "createdAt": "2026-09-23T09:04:00.000Z",
          "replyCount": 2,
          "lastAt": "2026-09-23T09:06:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-pve-02",
          "authorId": "prn_dusty",
          "text": "pve-02 is running warm. I’m looking into it.",
          "subject": {
            "kind": "server",
            "id": "pve-02",
            "name": "pve-02"
          },
          "createdAt": "2026-09-23T08:58:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T08:58:00.000Z",
          "working": true,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-firmware",
          "authorId": "prn_mara",
          "text": "Is there new firmware for the access points?",
          "subject": null,
          "createdAt": "2026-09-23T08:12:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T08:12:00.000Z",
          "working": true,
          "runtime": null,
          "settled": null,
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-pve-memory",
          "authorId": "prn_mara",
          "text": "Why is pve-02 using so much memory?",
          "subject": {
            "kind": "server",
            "id": "pve-02",
            "name": "pve-02"
          },
          "createdAt": "2026-09-23T07:41:00.000Z",
          "replyCount": 3,
          "lastAt": "2026-09-23T07:44:00.000Z",
          "working": false,
          "runtime": {
            "provider": "claude",
            "fast": true
          },
          "settled": null,
          "waiting": true,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-pve-01",
          "authorId": "prn_dusty",
          "text": "pve-01 needs a look. I’m looking into it.",
          "subject": {
            "kind": "server",
            "id": "pve-01",
            "name": "pve-01"
          },
          "createdAt": "2026-09-23T07:31:00.000Z",
          "replyCount": 2,
          "lastAt": "2026-09-23T07:41:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-unifi",
          "authorId": "prn_dusty",
          "text": "UniFi needs a look. I’m looking into it.",
          "subject": {
            "kind": "connection",
            "id": "con_unifi",
            "name": "UniFi"
          },
          "createdAt": "2026-09-23T06:29:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-23T06:31:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-home-assistant",
          "authorId": "prn_dusty",
          "text": "Home Assistant needs a look. I’m looking into it.",
          "subject": {
            "kind": "connection",
            "id": "con_home-assistant",
            "name": "Home Assistant"
          },
          "createdAt": "2026-09-23T05:12:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-23T05:14:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-backups",
          "authorId": "prn_dusty",
          "text": "Last night’s backups ran for all 12 guests. pve-02 is using more memory than usual, I’ll keep an eye on it.",
          "subject": null,
          "createdAt": "2026-09-23T05:00:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T05:00:00.000Z",
          "working": false,
          "runtime": null,
          "settled": null,
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-updates",
          "authorId": "prn_dusty",
          "text": "Install the updates on thetitan and the-falcon tonight? Both restart once after.",
          "subject": null,
          "createdAt": "2026-09-22T20:30:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-22T20:30:00.000Z",
          "working": false,
          "runtime": null,
          "settled": null,
          "waiting": true,
          "handedOver": false
        }
      ],
      "next": null,
      "settledCount": 14
    },
    "settled": {
      "threads": [
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_care-pve-03",
          "authorId": "prn_dusty",
          "text": "pve-03 is ready. I’m working out how to look after it.",
          "subject": {
            "kind": "server",
            "id": "pve-03",
            "name": "pve-03"
          },
          "createdAt": "2026-09-23T09:04:00.000Z",
          "replyCount": 2,
          "lastAt": "2026-09-23T09:06:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-pve-02",
          "authorId": "prn_dusty",
          "text": "pve-02 is running warm. I’m looking into it.",
          "subject": {
            "kind": "server",
            "id": "pve-02",
            "name": "pve-02"
          },
          "createdAt": "2026-09-23T08:58:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T08:58:00.000Z",
          "working": true,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-pve-01",
          "authorId": "prn_dusty",
          "text": "pve-01 needs a look. I’m looking into it.",
          "subject": {
            "kind": "server",
            "id": "pve-01",
            "name": "pve-01"
          },
          "createdAt": "2026-09-23T07:31:00.000Z",
          "replyCount": 2,
          "lastAt": "2026-09-23T07:41:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-unifi",
          "authorId": "prn_dusty",
          "text": "UniFi needs a look. I’m looking into it.",
          "subject": {
            "kind": "connection",
            "id": "con_unifi",
            "name": "UniFi"
          },
          "createdAt": "2026-09-23T06:29:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-23T06:31:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_look-home-assistant",
          "authorId": "prn_dusty",
          "text": "Home Assistant needs a look. I’m looking into it.",
          "subject": {
            "kind": "connection",
            "id": "con_home-assistant",
            "name": "Home Assistant"
          },
          "createdAt": "2026-09-23T05:12:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-23T05:14:00.000Z",
          "working": false,
          "runtime": null
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-zonneplan",
          "authorId": "prn_mara",
          "text": "Is the Zonneplan integration in Home Assistant still doing anything?",
          "subject": null,
          "createdAt": "2026-09-22T19:02:00.000Z",
          "replyCount": 3,
          "lastAt": "2026-09-22T19:09:00.000Z",
          "working": false,
          "runtime": {
            "provider": "codex",
            "effort": "high"
          },
          "settled": {
            "at": "2026-09-22T19:15:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-cert",
          "authorId": "prn_mara",
          "text": "Renew the certificate on the NAS",
          "subject": null,
          "createdAt": "2026-09-22T12:20:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-22T12:23:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-23T07:20:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-login",
          "authorId": "prn_dusty",
          "text": "Fix the login redirect on the website",
          "subject": null,
          "createdAt": "2026-09-20T14:10:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-20T14:40:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-21T08:30:00.000Z",
            "how": "merged"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-disk",
          "authorId": "prn_mara",
          "text": "Which guests use the most disk on pve-01?",
          "subject": null,
          "createdAt": "2026-09-17T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-17T08:06:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-17T08:06:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-0",
          "authorId": "prn_mara",
          "text": "Can you rotate the Wi-Fi password for guests?",
          "subject": null,
          "createdAt": "2026-09-15T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-15T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-15T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-1",
          "authorId": "prn_mara",
          "text": "Why did the NAS wake up at 04:00?",
          "subject": null,
          "createdAt": "2026-09-13T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-13T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-13T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-2",
          "authorId": "prn_mara",
          "text": "Move the Plex library to the new disk",
          "subject": null,
          "createdAt": "2026-09-11T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-11T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-11T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-3",
          "authorId": "prn_mara",
          "text": "Is the UPS battery still good?",
          "subject": null,
          "createdAt": "2026-09-09T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-09T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-09T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-4",
          "authorId": "prn_mara",
          "text": "Turn off the porch light schedule",
          "subject": null,
          "createdAt": "2026-09-07T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-07T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-07T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-5",
          "authorId": "prn_mara",
          "text": "What uses the most bandwidth at night?",
          "subject": null,
          "createdAt": "2026-09-05T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-05T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-05T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-6",
          "authorId": "prn_mara",
          "text": "Update Home Assistant to the new release",
          "subject": null,
          "createdAt": "2026-09-03T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-03T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-03T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-7",
          "authorId": "prn_mara",
          "text": "Did the printer get its firmware?",
          "subject": null,
          "createdAt": "2026-09-01T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-01T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-01T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-8",
          "authorId": "prn_mara",
          "text": "Clean up old snapshots on pve-01",
          "subject": null,
          "createdAt": "2026-08-30T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-08-30T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-08-30T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-9",
          "authorId": "prn_mara",
          "text": "Why is the garage sensor offline?",
          "subject": null,
          "createdAt": "2026-08-28T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-08-28T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-08-28T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        }
      ],
      "next": null,
      "settledCount": 14
    },
    "unread": {
      "conversationId": "cnv_dm-dusty",
      "threads": []
    }
  },
  "examples": {
    "open": {
      "threads": [
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-t3-settle",
          "authorId": "prn_mara",
          "text": "Settle on the phone does nothing in the Feedback room. Can you fix it?",
          "subject": null,
          "createdAt": "2026-09-23T09:15:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-23T09:15:30.000Z",
          "working": false,
          "runtime": null,
          "settled": null,
          "waiting": false,
          "handedOver": true
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-firmware",
          "authorId": "prn_mara",
          "text": "Is there new firmware for the access points?",
          "subject": null,
          "createdAt": "2026-09-23T08:12:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T08:12:00.000Z",
          "working": true,
          "runtime": null,
          "settled": null,
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-pve-memory",
          "authorId": "prn_mara",
          "text": "Why is pve-02 using so much memory?",
          "subject": {
            "kind": "server",
            "id": "pve-02",
            "name": "pve-02"
          },
          "createdAt": "2026-09-23T07:41:00.000Z",
          "replyCount": 3,
          "lastAt": "2026-09-23T07:44:00.000Z",
          "working": false,
          "runtime": {
            "provider": "claude",
            "fast": true
          },
          "settled": null,
          "waiting": true,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-backups",
          "authorId": "prn_dusty",
          "text": "Last night’s backups ran for all 12 guests. pve-02 is using more memory than usual, I’ll keep an eye on it.",
          "subject": null,
          "createdAt": "2026-09-23T05:00:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-23T05:00:00.000Z",
          "working": false,
          "runtime": null,
          "settled": null,
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-updates",
          "authorId": "prn_dusty",
          "text": "Install the updates on thetitan and the-falcon tonight? Both restart once after.",
          "subject": null,
          "createdAt": "2026-09-22T20:30:00.000Z",
          "replyCount": 0,
          "lastAt": "2026-09-22T20:30:00.000Z",
          "working": false,
          "runtime": null,
          "settled": null,
          "waiting": true,
          "handedOver": false
        }
      ],
      "next": null,
      "settledCount": 14
    },
    "settled": {
      "threads": [
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-cert",
          "authorId": "prn_mara",
          "text": "Renew the certificate on the NAS",
          "subject": null,
          "createdAt": "2026-09-22T12:20:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-22T12:23:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-23T07:20:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-zonneplan",
          "authorId": "prn_mara",
          "text": "Is the Zonneplan integration in Home Assistant still doing anything?",
          "subject": null,
          "createdAt": "2026-09-22T19:02:00.000Z",
          "replyCount": 3,
          "lastAt": "2026-09-22T19:09:00.000Z",
          "working": false,
          "runtime": {
            "provider": "codex",
            "effort": "high"
          },
          "settled": {
            "at": "2026-09-22T19:15:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-login",
          "authorId": "prn_dusty",
          "text": "Fix the login redirect on the website",
          "subject": null,
          "createdAt": "2026-09-20T14:10:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-20T14:40:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-21T08:30:00.000Z",
            "how": "merged"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-disk",
          "authorId": "prn_mara",
          "text": "Which guests use the most disk on pve-01?",
          "subject": null,
          "createdAt": "2026-09-17T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-17T08:06:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-17T08:06:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-0",
          "authorId": "prn_mara",
          "text": "Can you rotate the Wi-Fi password for guests?",
          "subject": null,
          "createdAt": "2026-09-15T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-15T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-15T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-1",
          "authorId": "prn_mara",
          "text": "Why did the NAS wake up at 04:00?",
          "subject": null,
          "createdAt": "2026-09-13T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-13T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-13T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-2",
          "authorId": "prn_mara",
          "text": "Move the Plex library to the new disk",
          "subject": null,
          "createdAt": "2026-09-11T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-11T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-11T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-3",
          "authorId": "prn_mara",
          "text": "Is the UPS battery still good?",
          "subject": null,
          "createdAt": "2026-09-09T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-09T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-09T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-4",
          "authorId": "prn_mara",
          "text": "Turn off the porch light schedule",
          "subject": null,
          "createdAt": "2026-09-07T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-07T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-07T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-5",
          "authorId": "prn_mara",
          "text": "What uses the most bandwidth at night?",
          "subject": null,
          "createdAt": "2026-09-05T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-05T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-05T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-6",
          "authorId": "prn_mara",
          "text": "Update Home Assistant to the new release",
          "subject": null,
          "createdAt": "2026-09-03T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-03T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-03T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-7",
          "authorId": "prn_mara",
          "text": "Did the printer get its firmware?",
          "subject": null,
          "createdAt": "2026-09-01T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-09-01T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-09-01T08:07:00.000Z",
            "how": "quiet"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-8",
          "authorId": "prn_mara",
          "text": "Clean up old snapshots on pve-01",
          "subject": null,
          "createdAt": "2026-08-30T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-08-30T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-08-30T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        },
        {
          "conversationId": "cnv_dm-dusty",
          "room": "chat",
          "rootId": "msg_chat-old-9",
          "authorId": "prn_mara",
          "text": "Why is the garage sensor offline?",
          "subject": null,
          "createdAt": "2026-08-28T08:05:00.000Z",
          "replyCount": 1,
          "lastAt": "2026-08-28T08:07:00.000Z",
          "working": false,
          "runtime": null,
          "settled": {
            "at": "2026-08-28T09:00:00.000Z",
            "how": "person"
          },
          "waiting": false,
          "handedOver": false
        }
      ],
      "next": null,
      "settledCount": 14
    },
    "unread": {
      "conversationId": "cnv_dm-dusty",
      "threads": [
        {
          "rootId": "msg_chat-pve-memory",
          "unread": 2
        }
      ]
    }
  }
};
