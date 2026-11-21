/**
 * UniFi Access's developer API as its API reference (assets.identity.ui.com/unifi-access/api_reference.pdf) shows the
 * answers, with its own example ids and names (no Access console here to read a real one): doors, their lock rules,
 * devices (lists of lists by hub; the reference's answer has no online flag, one reader here carries the webhook
 * payload's `online`), and today's door-openings log.
 */
export const ACCESS_doors = {
  code: 'SUCCESS',
  data: [
    {
      door_lock_relay_status: 'unlock',
      door_position_status: 'open',
      floor_id: '23c5db06-b59b-494d-94f1-23e88fbe4909',
      full_name: 'UNVR - 2F - A2 Door',
      id: '0ed545f8-2fcd-4839-9021-b39e707f6aa9',
      is_bind_hub: true,
      name: 'A2 Door',
      type: 'door',
    },
    {
      door_lock_relay_status: 'lock',
      door_position_status: 'close',
      floor_id: '7c62b4b3-692f-44ea-8eb8-e212833b4e0f',
      full_name: 'UNVR - 1F - Door 3855',
      id: '5785e97b-6123-4596-ba49-b6e51164db9b',
      is_bind_hub: true,
      name: 'Door 3855',
      type: 'door',
    },
    {
      door_lock_relay_status: 'lock',
      door_position_status: '',
      floor_id: '3275af8d-3fa7-4902-a11b-011e41c8464a',
      full_name: 'UNVR - 1F - Main Door',
      id: 'e4978b83-203d-4015-97df-b86efc91cb0c',
      is_bind_hub: true,
      name: 'Main Door',
      type: 'door',
    },
  ],
  msg: 'success',
};

export const ACCESS_rules = {
  '0ed545f8-2fcd-4839-9021-b39e707f6aa9': {
    code: 'SUCCESS',
    data: { ended_time: 3602128562, type: 'keep_unlock' },
    msg: 'success',
  },
  '5785e97b-6123-4596-ba49-b6e51164db9b': {
    code: 'SUCCESS',
    data: { ended_time: 1792616400, type: 'custom' },
    msg: 'success',
  },
  'e4978b83-203d-4015-97df-b86efc91cb0c': {
    code: 'SUCCESS',
    data: { ended_time: 3602128309, type: 'keep_lock' },
    msg: 'success',
  },
};

export const ACCESS_devices = {
  code: 'SUCCESS',
  data: [
    [
      { alias: 'UNVR - Main Floor', id: '7483c2773855', name: 'UA-HUB-3855', type: 'UAH' },
      { alias: 'UNVR - Main Floor', id: 'f492bfd28ced', name: 'UA-LITE-8CED', type: 'UDA-LITE' },
      { alias: 'UNVR - Main Floor', id: '0418d6a2bb7a', name: 'UA-G2-PRO-BB7A', type: 'UA-G2-PRO' },
    ],
  ],
  msg: 'success',
};

export const ACCESS_logs = {
  code: 'SUCCESS',
  data: {
    hits: [
      {
        '@timestamp': '2026-10-21T07:11:27Z',
        _id: 'log-1',
        _source: {
          actor: { alternate_id: '', alternate_name: '', display_name: 'N/A', id: '', type: 'user' },
          authentication: { credential_provider: 'NFC', issuer: '6FC02554' },
          event: {
            display_message: 'Access Denied / Unknown (NFC)',
            published: 1792566687000,
            reason: '',
            result: 'BLOCKED',
            type: 'access.door.unlock',
          },
          target: [
            {
              alternate_id: '',
              alternate_name: '',
              display_name: 'UA-HUB-3855',
              id: '7483c2773855',
              type: 'UAH',
            },
            {
              alternate_id: '',
              alternate_name: '',
              display_name: 'Door 3855',
              id: '5785e97b-6123-4596-ba49-b6e51164db9b',
              type: 'door',
            },
          ],
        },
        tag: 'access',
      },
      {
        '@timestamp': '2026-10-21T08:02:11Z',
        _id: 'log-2',
        _source: {
          actor: {
            alternate_id: '',
            alternate_name: '',
            display_name: 'Anna de Vries',
            id: 'u1',
            type: 'user',
          },
          authentication: { credential_provider: 'PIN_CODE', issuer: '' },
          event: {
            display_message: 'Access Granted (PIN)',
            published: 1792569731000,
            reason: '',
            result: 'ACCESS',
            type: 'access.door.unlock',
          },
          target: [
            {
              alternate_id: '',
              alternate_name: '',
              display_name: 'Main Door',
              id: 'e4978b83-203d-4015-97df-b86efc91cb0c',
              type: 'door',
            },
          ],
        },
        tag: 'access',
      },
    ],
  },
  page: 1,
  total: 2,
};

/** `GET /users` (the reference's “Fetch All Users”, cut to what Whombat reads): two active, one deactivated. */
export const ACCESS_users = {
  code: 'SUCCESS',
  data: [
    { id: 'u1', first_name: 'Anna', last_name: 'de Vries', onboard_time: 1792000000, status: 'ACTIVE' },
    { id: 'u2', first_name: 'Sam', last_name: 'Jansen', onboard_time: 1792500000, status: 'ACTIVE' },
    { id: 'u3', first_name: 'Old', last_name: 'Tenant', onboard_time: 1689048000, status: 'DEACTIVATED' },
  ],
  msg: 'success',
  pagination: { page_num: 1, page_size: 3, total: 3 },
};
