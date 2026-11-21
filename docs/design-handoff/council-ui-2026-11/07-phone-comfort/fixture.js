window.PHONE_FIXTURE = {
  "assistant": "Neo",
  "assistantSource": "01-groundwork/capture.json: agentWords(theAgentOf(bootstrap.principals)?.name).name",
  "person": "Mara Okafor",
  "clock": "11:22",
  "date": "2026-09-23T09:22:00Z",
  "question": "Why is pve-02 using so much memory?",
  "reply": "It’s at 91%, but 38 GB of that is the ZFS cache, which gives memory back when a guest needs it. Nothing is short right now.",
  "approval": "Limit the ZFS cache on pve-02 to 16 GB?",
  "consequence": "pve-02 restarts once to apply it",
  "members": [
    {
      "name": "Claude Opus 5.5",
      "provider": "Claude",
      "status": "Working",
      "time": "58 min",
      "mark": "claude",
      "letter": "C",
      "answer": null
    },
    {
      "name": "GPT 6.1 Sol",
      "provider": "Codex",
      "status": "8/10",
      "time": "22 min",
      "mark": "openai",
      "letter": "C",
      "answer": "Back up the NAS to Backblaze B2 with restic, every night. About €3 a month for your 500 GB, and the copy is in another country if the house burns down."
    },
    {
      "name": "Muse Wonder",
      "provider": "Muse Code",
      "status": "Didn’t answer",
      "time": "57 min",
      "mark": null,
      "letter": "M",
      "answer": null
    }
  ],
  "tasks": [
    {
      "id": "dlt_clogin2",
      "n": 2,
      "title": "Say what went wrong",
      "why": null,
      "checkbox": false,
      "picked": true,
      "working": true,
      "done": false,
      "muted": false,
      "attention": false,
      "status": "Working",
      "detail": "Changing LoginPage.tsx",
      "elapsed": "8 min",
      "program": "Claude",
      "ai": null,
      "note": null,
      "url": "http://thetitan:3773/env-1/login-errors",
      "pr": null,
      "stoppable": true,
      "shots": [],
      "folds": false,
      "label": "2. Say what went wrong: working, changing LoginPage.tsx"
    },
    {
      "id": "dlt_clogin3",
      "n": 3,
      "title": "Remember the email address",
      "why": null,
      "checkbox": false,
      "picked": true,
      "working": false,
      "done": false,
      "muted": false,
      "attention": false,
      "status": "After 2",
      "detail": null,
      "elapsed": null,
      "program": null,
      "ai": null,
      "note": null,
      "url": null,
      "pr": null,
      "stoppable": true,
      "shots": [],
      "folds": false,
      "label": "3. Remember the email address: after 2"
    }
  ],
  "councilHeading": "Council · Back up the NAS offsite",
  "councilStage": "Researching",
  "delegationHeading": "T3 Code · Make the login page clearer",
  "delegationStage": "1 of 3 merged · 1 working",
  "folded": {
    "label": "1 merged",
    "tasks": [
      {
        "id": "dlt_clogin1",
        "n": 1,
        "title": "A bigger Sign in button",
        "why": null,
        "checkbox": false,
        "picked": true,
        "working": false,
        "done": true,
        "muted": false,
        "attention": false,
        "status": "Merged",
        "detail": null,
        "elapsed": "5 min",
        "program": "Claude",
        "ai": null,
        "note": null,
        "url": "http://thetitan:3773/env-1/login-button",
        "pr": "https://github.com/cybexbv/whombat/pull/830",
        "stoppable": false,
        "shots": [],
        "folds": true,
        "label": "1. A bigger Sign in button: merged"
      }
    ]
  },
  "desk": {
    "name": "Lumio BV",
    "servers": [
      {
        "name": "pve-01",
        "line": "Proxmox · 16 cores"
      },
      {
        "name": "pve-02",
        "line": "Proxmox · 8 cores"
      }
    ]
  }
};
