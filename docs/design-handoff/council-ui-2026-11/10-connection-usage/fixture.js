// Frozen fixture response. The assistant value comes from agentWords(theAgentOf(principals)?.name).
const REVIEW_FIXTURE = {
  "assistant": "Neo",
  "clock": "2026-09-23T09:22:00.000Z",
  "timeZone": "Europe/Amsterdam",
  "thing": {
    "id": "connection:con_home-assistant",
    "kind": "connection",
    "connectionId": "con_home-assistant",
    "catalogId": "homeassistant",
    "name": "Home Assistant",
    "icon": "home",
    "status": "warn",
    "badge": "Needs a look",
    "facts": [
      [
        {
          "text": "Home Assistant "
        },
        {
          "text": "2026.10.2",
          "strong": true
        },
        {
          "text": " · Docker"
        }
      ],
      [
        {
          "text": "MariaDB "
        },
        {
          "text": "10.11",
          "strong": true
        }
      ],
      [
        {
          "text": "Up "
        },
        {
          "text": "3 d 7 h",
          "strong": true
        }
      ],
      [
        {
          "text": "Checked 2 min ago"
        }
      ]
    ],
    "address": "10.100.0.5:8123",
    "open": {
      "label": "Open Home Assistant",
      "url": "http://10.100.0.5:8123/"
    },
    "runsOn": {
      "serverId": "pve-02",
      "guestId": "pve:131",
      "name": "homeassistant (pve-02)",
      "href": "/things/server%3Apve-02?guest=pve%3A131",
      "how": "address"
    },
    "settings": true,
    "tabs": [
      {
        "key": "overview",
        "label": "Summary",
        "panels": [
          {
            "kind": "list",
            "id": "inventory",
            "place": "chart",
            "span": 1,
            "title": "In Home Assistant",
            "items": [
              {
                "id": "areas",
                "title": "Areas",
                "icon": "door",
                "right": "9",
                "url": "http://10.100.0.5:8123/config/areas/dashboard",
                "figure": {
                  "value": "9",
                  "note": "Nothing new"
                }
              },
              {
                "id": "devices",
                "title": "Devices",
                "icon": "device",
                "right": "148",
                "url": "http://10.100.0.5:8123/config/devices/dashboard",
                "figure": {
                  "value": "148",
                  "note": "+3 this week",
                  "tone": "ok"
                }
              },
              {
                "id": "automations",
                "title": "Automations",
                "icon": "clock",
                "right": "42",
                "url": "http://10.100.0.5:8123/config/automation/dashboard",
                "figure": {
                  "value": "42",
                  "note": "Ran 186 times today"
                }
              },
              {
                "id": "integrations",
                "title": "Integrations",
                "icon": "plug",
                "right": "102",
                "url": "http://10.100.0.5:8123/config/integrations/dashboard",
                "figure": {
                  "value": "102",
                  "note": "2 not loading",
                  "tone": "warn"
                }
              }
            ],
            "look": "counts"
          },
          {
            "kind": "gallery",
            "id": "cameras",
            "place": "chart",
            "span": 3,
            "title": "Cameras",
            "meta": "4 cameras",
            "shape": "wide",
            "items": [
              {
                "id": "camera.front_door",
                "title": "Front door",
                "image": {
                  "ref": "fx-wide-ha-front-door.fixture",
                  "alt": "Snapshot of Front door",
                  "shape": "wide"
                }
              },
              {
                "id": "camera.driveway",
                "title": "Driveway",
                "image": {
                  "ref": "fx-wide-ha-driveway.fixture",
                  "alt": "Snapshot of Driveway",
                  "shape": "wide"
                }
              },
              {
                "id": "camera.garden",
                "title": "Garden",
                "sub": "Recording",
                "image": {
                  "ref": "fx-wide-ha-garden.fixture",
                  "alt": "Snapshot of Garden",
                  "shape": "wide"
                }
              },
              {
                "id": "camera.back_door",
                "title": "Back door",
                "image": {
                  "ref": "fx-wide-ha-back-door.fixture",
                  "alt": "Snapshot of Back door",
                  "shape": "wide"
                }
              }
            ],
            "look": "shelf"
          },
          {
            "kind": "chart",
            "id": "automations-week",
            "place": "chart",
            "span": 1,
            "title": "This week",
            "meta": "Automations run per day",
            "timestamps": [
              "2026-09-17T09:22:00.000Z",
              "2026-09-18T09:22:00.000Z",
              "2026-09-19T09:22:00.000Z",
              "2026-09-20T09:22:00.000Z",
              "2026-09-21T09:22:00.000Z",
              "2026-09-22T09:22:00.000Z",
              "2026-09-23T09:22:00.000Z"
            ],
            "series": [
              {
                "key": "values",
                "label": "Runs",
                "values": [
                  168,
                  174,
                  181,
                  160,
                  192,
                  205,
                  186
                ],
                "color": "blue"
              }
            ],
            "figure": {
              "value": "1,266",
              "rest": "automation runs"
            },
            "style": "bars",
            "axis": {
              "min": 0
            },
            "labels": [
              "Thu",
              "Fri",
              "Sat",
              "Sun",
              "Mon",
              "Tue",
              "Today"
            ]
          },
          {
            "kind": "bars",
            "id": "people",
            "place": "chart",
            "span": 1,
            "title": "Who’s home",
            "meta": "2 of 4 home",
            "items": [
              {
                "id": "person-0",
                "label": "Mara",
                "note": "since 07:22",
                "value": "Home",
                "pct": null,
                "person": true
              },
              {
                "id": "person-1",
                "label": "Jules",
                "note": "since 04:22",
                "value": "Home",
                "pct": null,
                "person": true
              },
              {
                "id": "person-2",
                "label": "Sam",
                "note": "since 00:22",
                "value": "Work",
                "pct": null,
                "person": true
              },
              {
                "id": "person-3",
                "label": "Noor",
                "note": "since Mon",
                "value": "Away",
                "pct": null,
                "person": true
              }
            ]
          },
          {
            "kind": "bars",
            "id": "machine",
            "place": "chart",
            "span": 1,
            "title": "The machine",
            "meta": "homeassistant (pve-02)",
            "link": {
              "kind": "href",
              "label": "See homeassistant (pve-02)",
              "href": "/things/server%3Apve-02?guest=pve%3A131"
            },
            "items": [
              {
                "id": "cpu",
                "label": "Processor",
                "note": "of 4 cores",
                "value": "2 %",
                "pct": 0.02
              },
              {
                "id": "memory",
                "label": "Memory",
                "value": "3.0 of 8 GB",
                "pct": 0.38
              },
              {
                "id": "disk",
                "label": "Disk",
                "value": "30 of 40 GB",
                "pct": 0.76,
                "tone": "warn",
                "sub": "Full in about 2 months",
                "subTone": "warn"
              },
              {
                "id": "ha-version",
                "label": "Home Assistant",
                "value": "2026.10.2",
                "pct": null,
                "sub": "Container"
              },
              {
                "id": "ha-database",
                "label": "Database",
                "note": "MariaDB 10.11",
                "value": "6.0 GB",
                "pct": null,
                "sub": "Grows 110 MB a day"
              }
            ]
          },
          {
            "kind": "list",
            "id": "loading",
            "width": "wide",
            "place": "main",
            "title": "Integrations not loading",
            "meta": "2 of 102",
            "link": {
              "kind": "tab",
              "label": "All integrations",
              "tab": "integrations"
            },
            "items": [
              {
                "id": "shelly-pool",
                "title": "Shelly · Pool pump",
                "detail": "Retrying · cannot reach 10.100.0.87 since Thu 07:12",
                "tone": "warn"
              },
              {
                "id": "shelly-garage",
                "title": "Shelly · Garage door",
                "detail": "Retrying · cannot reach 10.100.0.91 since Thu 07:12",
                "tone": "warn"
              }
            ]
          },
          {
            "kind": "list",
            "id": "backups",
            "width": "wide",
            "place": "main",
            "title": "Backups",
            "link": {
              "kind": "tab",
              "label": "Backups",
              "tab": "backups"
            },
            "items": [
              {
                "id": "proxmox",
                "title": "Proxmox backs up CT 131 every day",
                "detail": "backup-homeassistant-daytime · today 07:30 · 4.2 GB",
                "tone": "ok",
                "right": "next in 21 h"
              },
              {
                "id": "old",
                "title": "8.7 GB of old Home Assistant backups on its own disk",
                "detail": "23 files, oldest from March",
                "tone": "warn"
              }
            ]
          },
          {
            "kind": "notices",
            "id": "worth",
            "place": "top",
            "title": "Worth a look",
            "items": [
              {
                "id": "disk",
                "tone": "info",
                "icon": "disk",
                "title": "Disk full in about 2 months",
                "detail": "8.7 GB is old backups",
                "nature": "fyi",
                "check": "machine.disk_forecast"
              },
              {
                "id": "log",
                "tone": "warn",
                "icon": "log",
                "title": "Modbus fills the log",
                "detail": "92 % of 12,286 errors, still coming in",
                "link": {
                  "kind": "tab",
                  "label": "Show them",
                  "tab": "logs"
                }
              },
              {
                "id": "integrations",
                "tone": "bad",
                "icon": "plug",
                "title": "2 integrations not loading",
                "detail": "Shelly pool pump, garage door",
                "link": {
                  "kind": "ask",
                  "label": "Look into it",
                  "question": "Why are two integrations not loading in Home Assistant?"
                }
              },
              {
                "id": "repairs",
                "tone": "warn",
                "icon": "warn",
                "title": "3 HomeWizard meters need a new sign-in",
                "detail": "Zwembad Techniek, Schuilstal, WTW Zolder",
                "link": {
                  "kind": "ask",
                  "label": "Repair",
                  "question": "Three HomeWizard meters in Home Assistant need a new sign-in. Can you repair them?"
                }
              },
              {
                "id": "update",
                "tone": "info",
                "icon": "update",
                "title": "Home Assistant has an update",
                "detail": "Version 2026.10.3, with a fix for the Modbus integration",
                "link": {
                  "kind": "ask",
                  "label": "Decide",
                  "question": "Should I update Home Assistant to 2026.10.3?"
                }
              },
              {
                "id": "recorder",
                "tone": "info",
                "icon": "database",
                "title": "The database grows 110 MB a day",
                "detail": "sensor.evcs_* writes every second",
                "link": {
                  "kind": "ask",
                  "label": "Look into it",
                  "question": "Why does Home Assistant’s database grow 110 MB a day?"
                }
              },
              {
                "id": "zigbee",
                "tone": "info",
                "icon": "device",
                "title": "2 Zigbee sensors report a low battery",
                "detail": "Hallway motion, Garage door contact"
              },
              {
                "id": "cert",
                "tone": "info",
                "icon": "key",
                "title": "Its certificate ends in 24 days",
                "detail": "Let’s Encrypt renews it by itself"
              },
              {
                "id": "backup-age",
                "tone": "info",
                "icon": "backup",
                "title": "No backup of its own in 40 days",
                "detail": "Proxmox backs up the whole machine every day"
              }
            ],
            "empty": "Nothing needs a look."
          },
          {
            "kind": "changes",
            "id": "changes",
            "width": "wide",
            "place": "main",
            "title": "Changes here",
            "limit": 5
          },
          {
            "kind": "access",
            "id": "access",
            "width": "wide",
            "place": "main",
            "title": "What Whombat may do",
            "items": [
              {
                "label": "Read states and history",
                "tier": "allowed",
                "count": 4
              },
              {
                "label": "Switch and set things",
                "tier": "allowed",
                "count": 3
              },
              {
                "label": "Locks, alarms and doors",
                "tier": "ask",
                "count": 2
              }
            ],
            "lookOnly": false
          },
          {
            "kind": "widgets",
            "id": "more",
            "place": "bottom",
            "title": "Show more here",
            "suggestions": [
              "Database size",
              "Errors per hour",
              "Integrations loading"
            ]
          }
        ]
      },
      {
        "key": "integrations",
        "label": "Integrations",
        "count": 102,
        "panels": [
          {
            "kind": "table",
            "id": "integrations",
            "title": "Integrations",
            "meta": "100 of 102 loaded",
            "columns": [
              {
                "key": "name",
                "label": "Integration"
              },
              {
                "key": "entry",
                "label": "Entry"
              },
              {
                "key": "state",
                "label": "State"
              }
            ],
            "rows": [
              {
                "id": "Shelly-Pool pump",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "Pool pump",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Retrying",
                    "note": "since Thu 07:12",
                    "dot": "warn"
                  }
                }
              },
              {
                "id": "Shelly-Garage door",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "Garage door",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Retrying",
                    "note": "since Thu 07:12",
                    "dot": "warn"
                  }
                }
              },
              {
                "id": "MQTT-Mosquitto",
                "cells": {
                  "name": {
                    "text": "MQTT"
                  },
                  "entry": {
                    "text": "Mosquitto",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "KNX-KNX tunnel",
                "cells": {
                  "name": {
                    "text": "KNX"
                  },
                  "entry": {
                    "text": "KNX tunnel",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Zigbee Home Automation-SkyConnect",
                "cells": {
                  "name": {
                    "text": "Zigbee Home Automation"
                  },
                  "entry": {
                    "text": "SkyConnect",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "UniFi Network-UDM Pro Max",
                "cells": {
                  "name": {
                    "text": "UniFi Network"
                  },
                  "entry": {
                    "text": "UDM Pro Max",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Sonos-Living room",
                "cells": {
                  "name": {
                    "text": "Sonos"
                  },
                  "entry": {
                    "text": "Living room",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Met.no-Home",
                "cells": {
                  "name": {
                    "text": "Met.no"
                  },
                  "entry": {
                    "text": "Home",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Google Cast-Kitchen display",
                "cells": {
                  "name": {
                    "text": "Google Cast"
                  },
                  "entry": {
                    "text": "Kitchen display",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "HomeKit Bridge-Whole house",
                "cells": {
                  "name": {
                    "text": "HomeKit Bridge"
                  },
                  "entry": {
                    "text": "Whole house",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Mobile App-Mara’s phone",
                "cells": {
                  "name": {
                    "text": "Mobile App"
                  },
                  "entry": {
                    "text": "Mara’s phone",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Mobile App-John’s phone",
                "cells": {
                  "name": {
                    "text": "Mobile App"
                  },
                  "entry": {
                    "text": "John’s phone",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Philips Hue-Bridge",
                "cells": {
                  "name": {
                    "text": "Philips Hue"
                  },
                  "entry": {
                    "text": "Bridge",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Solar-Inverter",
                "cells": {
                  "name": {
                    "text": "Solar"
                  },
                  "entry": {
                    "text": "Inverter",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "P1 meter-Energy",
                "cells": {
                  "name": {
                    "text": "P1 meter"
                  },
                  "entry": {
                    "text": "Energy",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-1",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-1",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-1",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-1",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-1",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-1",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-1",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-1",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-1",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-1",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-2",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-2",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-2",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-2",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-2",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-2",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-2",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-2",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-2",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-2",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-3",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-3",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-3",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-3",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-3",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-3",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-3",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-3",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-3",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-3",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-4",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-4",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-4",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-4",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-4",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-4",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-4",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-4",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-4",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-4",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-5",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-5",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-5",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-5",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-5",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-5",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-5",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-5",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-5",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-5",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-6",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-6",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-6",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-6",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-6",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-6",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-6",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-6",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-6",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-6",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-7",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-7",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-7",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-7",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-7",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-7",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-7",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-7",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-7",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-7",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-8",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-8",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-8",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-8",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-8",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-8",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-8",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-8",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-8",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-8",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-9",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-9",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-9",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-9",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-9",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-9",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-garage-sensor-9",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "garage-sensor-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-attic-plug-9",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "attic-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-shed-plug-9",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "shed-plug-9",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-kitchen-sensor-10",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "kitchen-sensor-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-hall-plug-10",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "hall-plug-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-garden-plug-10",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "garden-plug-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "ESPHome-bathroom-sensor-10",
                "cells": {
                  "name": {
                    "text": "ESPHome"
                  },
                  "entry": {
                    "text": "bathroom-sensor-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Shelly-office-plug-10",
                "cells": {
                  "name": {
                    "text": "Shelly"
                  },
                  "entry": {
                    "text": "office-plug-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              },
              {
                "id": "Tasmota-bedroom-plug-10",
                "cells": {
                  "name": {
                    "text": "Tasmota"
                  },
                  "entry": {
                    "text": "bedroom-plug-10",
                    "tone": "muted"
                  },
                  "state": {
                    "text": "Loaded",
                    "dot": "ok"
                  }
                }
              }
            ]
          }
        ]
      },
      {
        "key": "logs",
        "label": "Log",
        "panels": [
          {
            "kind": "list",
            "id": "log",
            "title": "Errors since the restart",
            "meta": "12,286 errors · 112 warnings",
            "items": [
              {
                "id": "modbus",
                "title": "Modbus: no answer from the EV charger",
                "detail": "modbus · since Thu 07:12, still coming in",
                "tone": "bad",
                "icon": "log",
                "right": "×11,280"
              },
              {
                "id": "shelly",
                "title": "Shelly: cannot reach 10.100.0.87",
                "detail": "shelly · retrying since Thu 07:12",
                "tone": "bad",
                "icon": "plug",
                "right": "×612"
              },
              {
                "id": "homewizard",
                "title": "HomeWizard: the sign-in expired",
                "detail": "homewizard · three meters",
                "tone": "bad",
                "icon": "key",
                "right": "×288"
              },
              {
                "id": "recorder",
                "title": "The recorder is slow to write",
                "detail": "recorder · during the backup at 07:30",
                "tone": "warn",
                "icon": "database",
                "right": "×84"
              },
              {
                "id": "esphome",
                "title": "ESPHome: garden-sensor came back",
                "detail": "esphome · 12:04",
                "tone": "warn",
                "icon": "device",
                "right": "×28"
              }
            ]
          }
        ]
      },
      {
        "key": "backups",
        "label": "Backups",
        "panels": [
          {
            "kind": "list",
            "id": "proxmox",
            "title": "Whole machine, by Proxmox",
            "meta": "every day at 07:30 · keeps 14 days",
            "items": [
              {
                "id": "vzdump-0",
                "title": "Today’s backup",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-23T05:31:00.000Z",
                "tone": "ok"
              },
              {
                "id": "vzdump-1",
                "title": "Backup of yesterday",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-22T05:31:00.000Z",
                "tone": "ok"
              },
              {
                "id": "vzdump-2",
                "title": "Backup of 2 days ago",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-21T05:31:00.000Z",
                "tone": "ok"
              },
              {
                "id": "vzdump-3",
                "title": "Backup of 3 days ago",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-20T05:31:00.000Z",
                "tone": "ok"
              },
              {
                "id": "vzdump-4",
                "title": "Backup of 4 days ago",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-19T05:31:00.000Z",
                "tone": "ok"
              },
              {
                "id": "vzdump-5",
                "title": "Backup of 5 days ago",
                "detail": "On pbs-01 · 4.2 GB",
                "at": "2026-09-18T05:31:00.000Z",
                "tone": "ok"
              }
            ]
          },
          {
            "kind": "list",
            "id": "own",
            "title": "Home Assistant’s own",
            "items": [
              {
                "id": "kiosk",
                "title": "Settings copy before the kiosk update",
                "detail": "In its own backups folder · 1.8 GB",
                "at": "2026-09-22T14:02:00.000Z",
                "tone": "ok"
              },
              {
                "id": "old",
                "title": "Copies from before 2026.9",
                "detail": "23 old copies on the same disk",
                "at": "2026-08-14T07:00:00.000Z",
                "tone": "warn",
                "right": "8.7 GB"
              }
            ]
          }
        ]
      }
    ],
    "actions": [
      {
        "id": "restart",
        "label": "Restart",
        "icon": "restart",
        "confirm": {
          "title": "Restart Home Assistant?",
          "body": "It stops for about a minute. Automations that would run in that minute are skipped.",
          "button": "Restart"
        },
        "allowed": true
      }
    ],
    "readAt": "2026-09-23T09:22:00.000Z",
    "range": "24h",
    "ranges": [
      "1h",
      "6h",
      "24h",
      "7d",
      "30d"
    ],
    "refreshS": 60,
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
  }
};
