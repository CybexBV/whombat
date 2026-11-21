/**
 * Regenerates every cross-language artifact from the TypeScript contracts:
 *   schema/<Name>.json               JSON Schema (draft 2020-12) of each registry entry
 *   vectors/*.json                   conformance vectors (gen-vectors.ts)
 *   go/internal/schemas/json/*.json  the same JSON Schema, embedded by the Go module
 *   go/testdata/vectors/*.json       the same vectors, for `go test`
 *   go/<pkg>/types_gen.go            Go types + Parse/Validate (gen-go.ts)
 *   go/<pkg>/constants_gen.go        limits, close codes, frame types, purposes
 * Run `pnpm gen`; `pnpm gen:check` fails when the committed files differ (CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as control from '@whombat/control-contracts';
import * as device from '@whombat/control-contracts/device';
import * as local from '@whombat/control-contracts/local';
import {
  DESK_PIN_MAX,
  DESK_PIN_MIN,
  DESK_TALK_WAIT_MAX_S,
  DESK_TALK_WORKING_S,
  HELP_CODE_ALPHABET,
  HELP_CODE_LENGTH,
  REMOTE_HELP_DURATION_S,
  REMOTE_HELP_LIMITS,
  REMOTE_HELP_UNIT_RE,
  VOICE_DOWNLOAD_MODELS,
  VOICE_LANGUAGES,
  VOICE_MODEL_CHOICES,
  VOICE_MODEL_PROBLEMS,
  VOICE_MODEL_STATES,
  VOICE_TYPING_MAX_BYTES,
  VOICE_TYPING_MAX_SECONDS,
  VOICE_TYPING_TEXT_MAX,
} from '@whombat/core/domain';
import * as protocol from '@whombat/protocol';
import * as release from '@whombat/release';
import { z } from 'zod';
import { generateGo, goName } from './gen-go.ts';
import { buildVectors } from './gen-vectors.ts';
import { GO_PACKAGES, type GoPackage, REGISTRY } from './registry.ts';
import { checkSubset } from './subset.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const GO_MODULE = 'github.com/CybexBV/whombat/contracts/go';
export const SCHEMA_ID = (name: string) => `https://schemas.whombat.com/contracts/${name}.json`;

export function jsonSchemaOf(name: string, schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  const { $schema, ...rest } = js;
  return { $schema, $id: SCHEMA_ID(name), title: name, ...rest };
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function constants(pkg: GoPackage): string {
  const lines: string[] = [];
  const num = (name: string, v: number) => lines.push(`\t${name} = ${v}`);
  const str = (name: string, v: string) => lines.push(`\t${name} = ${JSON.stringify(v)}`);
  const pascal = (s: string) => goName(s.toLowerCase());
  const block = (title: string) => lines.push(`\n\t// ${title}`);
  if (pkg === 'protocol') {
    block('Limits (packages/protocol/src/limits.ts).');
    for (const [k, v] of Object.entries(protocol))
      if (typeof v === 'number' && /^(RELAY|DIRECT|TICKET|FRAME|SESSION|UPLOAD|ENROLL)_/.test(k))
        num(pascal(k), v);
    block('Relay protocol v1.');
    str('RelayPath', protocol.RELAY_PATH);
    str('RelaySubprotocol', protocol.RELAY_SUBPROTOCOL);
    for (const [k, v] of Object.entries(protocol.RELAY_CLOSE)) num(`RelayClose${goName(k)}`, v);
    str('RelayCloseReasonLease', protocol.RELAY_CLOSE_REASON_LEASE);
    block('The direct listener (HE-50, CT-1250).');
    str('DirectPath', protocol.DIRECT_PATH);
    str('DirectSubprotocol', protocol.DIRECT_SUBPROTOCOL);
    for (const [k, v] of Object.entries(protocol.DIRECT_CLOSE)) num(`DirectClose${goName(k)}`, v);
    block('Admission tickets.');
    str('AdmissionTyp', protocol.ADMISSION_TYP);
    str('AdmissionAlg', protocol.ADMISSION_ALG);
    block('Appliance licence (LC-01, LC-02).');
    str('LicenceTyp', protocol.LICENCE_TYP);
    str('LicenceAlg', protocol.LICENCE_ALG);
    str('LicenceAudiencePrefix', protocol.LICENCE_AUDIENCE_PREFIX);
    num('LicenceLifetimeS', protocol.LICENCE_LIFETIME_S);
    num('LicenceRenewS', protocol.LICENCE_RENEW_S);
    num('LicenceRenewUnpaidS', protocol.LICENCE_RENEW_UNPAID_S);
    num('LicenceGraceS', protocol.LICENCE_GRACE_S);
    num('LicenceClockSkewS', protocol.LICENCE_CLOCK_SKEW_S);
    num('LicenceMaxBytes', protocol.LICENCE_MAX_BYTES);
    block('Session frames.');
    for (const [k, v] of Object.entries(protocol.FRAME_TYPE)) num(`FrameType${goName(k)}`, v);
    num('ControlStreamID', protocol.CONTROL_STREAM_ID);
    num('MaxStreamID', protocol.MAX_STREAM_ID);
    for (const [k, v] of Object.entries(protocol.STREAM_RESET)) num(`StreamReset${goName(k)}`, v);
    block('The own address (4.3; Whombat own-address.md): shapes only, never the word list.');
    str('OwnAddressLabelPattern', protocol.OWN_ADDRESS_LABEL_RE.source);
    str('OwnAddressHostPattern', protocol.OWN_ADDRESS_HOST_RE.source);
    str('OwnAddressZoneProd', protocol.OWN_ADDRESS_ZONES.prod);
    str('OwnAddressZoneDev', protocol.OWN_ADDRESS_ZONES.dev);
    str('OwnAddressClaimPath', protocol.OWN_ADDRESS_CLAIM_PATH);
    num('BoxAssetLinksMaxAgeS', protocol.BOX_ASSET_LINKS_MAX_AGE_S);
    block('Whombat Link (4.4; Whombat whombat-link.md).');
    str('LinkCodePattern', protocol.LINK_CODE_RE.source);
    num('LinkCodeTTLS', protocol.LINK_CODE_TTL_S);
    str('LinkPagePath', protocol.LINK_PAGE_PATH);
    num('LinkGraceS', protocol.LINK_GRACE_S);
    num('LinkTrialDays', protocol.LINK_TRIAL_DAYS);
    num('LinkTrialBoxesMax', protocol.LINK_TRIAL_BOXES_MAX);
    block('Claim ceremony (CC-01, CC-06).');
    str('ClaimCodeAlphabet', protocol.CLAIM_CODE_ALPHABET);
    num('ClaimLettersLength', protocol.CLAIM_LETTERS_LENGTH);
    str('CPaceSuite', protocol.CPACE_SUITE);
    str('CPaceDSI', protocol.CPACE_DSI);
    str('ClaimPakeCITag', protocol.CLAIM_PAKE_CI_TAG);
    str('ClaimConfirmInfo', protocol.CLAIM_CONFIRM_INFO);
    num('ClaimConfirmTagBytes', protocol.CLAIM_CONFIRM_TAG_BYTES);
  } else if (pkg === 'release') {
    str('AssignmentPurpose', release.ASSIGNMENT_PURPOSE);
    num('AssignmentMaxLifetimeS', release.ASSIGNMENT_MAX_LIFETIME_S);
    str('DefaultUpdateChannel', release.DEFAULT_UPDATE_CHANNEL);
    str('ClientChannelPurpose', release.CLIENT_CHANNEL_PURPOSE);
    str('ClientChannelTarget', release.CLIENT_CHANNEL_TARGET);
    num('ClientChannelMaxLifetimeS', release.CLIENT_CHANNEL_MAX_LIFETIME_S);
    num('ClientChannelMaxBundles', release.CLIENT_CHANNEL_MAX_BUNDLES);
  } else if (pkg === 'local') {
    num('LocalAPIVersion', local.LOCAL_API_VERSION);
    str('BackupStatusKind', local.BACKUP_STATUS_KIND);
    for (const [k, v] of Object.entries(local.MANAGER_PATHS)) str(`ManagerPath${goName(k)}`, v);
    for (const [k, v] of Object.entries(local.ADMIN_PATHS)) str(`AdminPath${goName(k)}`, v);
    str('ConsoleFileEnv', local.CONSOLE_FILE_ENV);
    str('ConsoleFileDefault', local.CONSOLE_FILE_DEFAULT);
    block('Desk socket (CT-528…CT-531).');
    str('DeskSocketEnv', local.DESK_SOCKET_ENV);
    str('DeskSocketDefault', local.DESK_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.DESK_PATHS)) str(`DeskPath${goName(k)}`, v);
    num('DeskRequestMaxBytes', local.DESK_REQUEST_MAX_BYTES);
    num('DeskTalkRequestMaxBytes', local.DESK_TALK_REQUEST_MAX_BYTES);
    num('DeskHearRequestMaxBytes', local.DESK_HEAR_REQUEST_MAX_BYTES);
    num('DeskHearBase64Max', local.DESK_HEAR_BASE64_MAX);
    num('DeskStateMaxBytes', local.DESK_STATE_MAX_BYTES);
    num('DeskSessionMaxBytes', local.DESK_SESSION_MAX_BYTES);
    num('DeskSessionMessages', local.DESK_SESSION_MESSAGES);
    num('DeskSessionParagraphs', local.DESK_SESSION_PARAGRAPHS);
    num('DeskFoundItems', local.DESK_FOUND_ITEMS);
    num('DeskServers', local.DESK_SERVERS);
    num('DeskServerPoints', local.DESK_SERVER_POINTS);
    num('DeskServerVolumes', local.DESK_SERVER_VOLUMES);
    num('DeskServerGuests', local.DESK_SERVER_GUESTS);
    num('DeskServerAlerts', local.DESK_SERVER_ALERTS);
    num('DeskServerMaxBytes', local.DESK_SERVER_MAX_BYTES);
    str('DeskServerIDPattern', local.DESK_SERVER_ID_RE.source);
    num('DeskAskChoices', local.DESK_ASK_CHOICES);
    num('DeskTalkWorkingS', DESK_TALK_WORKING_S);
    num('DeskTalkWaitMaxS', DESK_TALK_WAIT_MAX_S);
    num('DeskAudioSampleRate', local.DESK_AUDIO_SAMPLE_RATE);
    num('DeskAudioMaxSeconds', local.DESK_AUDIO_MAX_SECONDS);
    num('DeskAudioMaxBytes', local.DESK_AUDIO_MAX_BYTES);
    num('DeskAudioBase64Max', local.DESK_AUDIO_BASE64_MAX);
    num('DeskQuestionMax', local.DESK_QUESTION_MAX);
    num('DeskTalkTextMax', local.DESK_TALK_TEXT_MAX);
    num('DeskAnswerMax', local.DESK_ANSWER_MAX);
    num('DeskPinMin', DESK_PIN_MIN);
    num('DeskPinMax', DESK_PIN_MAX);
    for (const code of local.DESK_SOCKET_ERRORS) str(`DeskError${goName(code)}`, code);
    block('Voice socket (CT-532).');
    str('VoiceSocketEnv', local.VOICE_SOCKET_ENV);
    str('VoiceSocketDefault', local.VOICE_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.VOICE_PATHS)) str(`VoicePath${goName(k)}`, v);
    num('VoiceQueueMax', local.VOICE_QUEUE_MAX);
    num('VoicePromptMax', local.VOICE_PROMPT_MAX);
    num('VoiceTtsTextMax', local.VOICE_TTS_TEXT_MAX);
    num('VoiceTtsWavMaxBytes', local.VOICE_TTS_WAV_MAX_BYTES);
    num('VoiceTtsBase64Max', local.VOICE_TTS_BASE64_MAX);
    for (const code of local.VOICE_ERRORS) str(`VoiceError${goName(code)}`, code);
    num('VoiceTranscribeBase64Max', local.VOICE_TRANSCRIBE_BASE64_MAX);
    num('VoiceTranscribeRequestMaxBytes', local.VOICE_TRANSCRIBE_REQUEST_MAX_BYTES);
    num('VoiceTypingMaxSeconds', VOICE_TYPING_MAX_SECONDS);
    num('VoiceTypingMaxBytes', VOICE_TYPING_MAX_BYTES);
    num('VoiceTypingTextMax', VOICE_TYPING_TEXT_MAX);
    num('VoiceTextPartMax', local.VOICE_TEXT_PART_MAX);
    num('VoiceTextPartsMax', local.VOICE_TEXT_PARTS_MAX);
    for (const m of VOICE_DOWNLOAD_MODELS) str(`VoiceModel${goName(m)}`, m);
    for (const c of VOICE_MODEL_CHOICES) str(`VoiceChoice${goName(c)}`, c);
    for (const l of VOICE_LANGUAGES) str(`VoiceLanguage${goName(l)}`, l);
    block('Voice models socket (3.1).');
    str('VoiceModelsSocketEnv', local.VOICE_MODELS_SOCKET_ENV);
    str('VoiceModelsSocketDefault', local.VOICE_MODELS_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.VOICE_MODELS_PATHS)) str(`VoiceModelsPath${goName(k)}`, v);
    num('VoiceModelMaxBytes', local.VOICE_MODEL_MAX_BYTES);
    for (const st of VOICE_MODEL_STATES) str(`VoiceModelState${goName(st)}`, st);
    for (const pr of VOICE_MODEL_PROBLEMS) str(`VoiceModelProblem${goName(pr)}`, pr);
    block('Presence socket (CT-597).');
    str('PresenceSocketEnv', local.PRESENCE_SOCKET_ENV);
    str('PresenceSocketDefault', local.PRESENCE_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.PRESENCE_PATHS)) str(`PresencePath${goName(k)}`, v);
    num('PresenceKeepS', local.PRESENCE_KEEP_S);
    num('PresenceRequestMaxBytes', local.PRESENCE_REQUEST_MAX_BYTES);
    for (const code of local.PRESENCE_ERRORS) str(`PresenceError${goName(code)}`, code);
    block('The box’s network on the manager and desk sockets (CT-564, CT-569, CT-573).');
    num('SsidMaxBytes', protocol.SSID_MAX_BYTES);
    for (const code of protocol.WIFI_ERROR_CODES) str(`WifiError${goName(code)}`, code);
    for (const code of protocol.CABLE_ERROR_CODES) str(`CableError${goName(code)}`, code);
    block('Bluetooth socket and Bluetooth on the desk socket (CT-670…CT-684).');
    str('BluetoothSocketEnv', local.BLUETOOTH_SOCKET_ENV);
    str('BluetoothSocketDefault', local.BLUETOOTH_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.BLUETOOTH_PATHS)) str(`BluetoothPath${goName(k)}`, v);
    num('BluetoothRequestMaxBytes', local.BLUETOOTH_REQUEST_MAX_BYTES);
    num('BluetoothAnswerMaxBytes', local.BLUETOOTH_ANSWER_MAX_BYTES);
    num('BluetoothNameMax', protocol.BLUETOOTH_NAME_MAX);
    num('BluetoothScanMax', protocol.BLUETOOTH_SCAN_MAX);
    num('BluetoothDevicesMax', protocol.BLUETOOTH_DEVICES_MAX);
    num('BluetoothScanS', protocol.BLUETOOTH_SCAN_S);
    num('BluetoothPairingS', protocol.BLUETOOTH_PAIRING_S);
    num('BluetoothConnectS', protocol.BLUETOOTH_CONNECT_S);
    num('BluetoothPollMs', protocol.BLUETOOTH_POLL_MS);
    num('BluetoothResultKeepS', protocol.BLUETOOTH_RESULT_KEEP_S);
    for (const code of local.BLUETOOTH_SOCKET_ERRORS) str(`BluetoothError${goName(code)}`, code);
    block('Support socket and remote help (CT-930…CT-942).');
    str('SupportSocketEnv', local.SUPPORT_SOCKET_ENV);
    str('SupportSocketDefault', local.SUPPORT_SOCKET_DEFAULT);
    for (const [k, v] of Object.entries(local.SUPPORT_PATHS)) str(`SupportPath${goName(k)}`, v);
    num('SupportRequestMaxBytes', local.SUPPORT_REQUEST_MAX_BYTES);
    num('SupportAnswerMaxBytes', local.SUPPORT_ANSWER_MAX_BYTES);
    num('SupportEventsWaitMaxS', local.SUPPORT_EVENTS_WAIT_MAX_S);
    num('SupportEventsMax', local.SUPPORT_EVENTS_MAX);
    for (const code of local.SUPPORT_ERRORS) str(`SupportError${goName(code)}`, code);
    num('HelpCodeLength', HELP_CODE_LENGTH);
    str('HelpCodeAlphabet', HELP_CODE_ALPHABET);
    for (const [k, v] of Object.entries(REMOTE_HELP_DURATION_S)) num(`RemoteHelpDuration${goName(k)}S`, v);
    for (const [k, v] of Object.entries(REMOTE_HELP_LIMITS)) num(`RemoteHelp${goName(k)}`, v);
    str('RemoteHelpUnitPattern', REMOTE_HELP_UNIT_RE.source);
    num('RemoteHelpStepSecondsMax', protocol.REMOTE_HELP_STEP_SECONDS_MAX);
    num('RemoteHelpVisitsMax', protocol.REMOTE_HELP_VISITS_MAX);
    str('SSHEd25519PublicKeyPattern', protocol.SSH_ED25519_PUBLIC_KEY_RE.source);
    block('The own address (4.3; Whombat own-address.md).');
    str('OwnAddressACMESocket', local.OWN_ADDRESS_ACME_SOCKET);
    num('OwnAddressACMEConnectionsMax', local.OWN_ADDRESS_ACME_CONNECTIONS_MAX);
    num('OwnAddressStatePollS', local.OWN_ADDRESS_STATE_POLL_S);
    num('OwnAddressCtPollS', local.OWN_ADDRESS_CT_POLL_S);
    for (const code of local.OWN_ADDRESS_ERRORS)
      str(`OwnAddressError${goName(code.replace('own_address.', ''))}`, code);
    block('Whombat Link and the update channel (4.4; Whombat whombat-link.md).');
    num('LinkStatePollS', local.LINK_STATE_POLL_S);
    for (const code of local.LINK_ERRORS)
      str(`LinkError${goName(code.replace(/^link[.]/, '').replace('.', '_'))}`, code);
  } else {
    str('DeviceRequestPurpose', device.DEVICE_REQUEST_PURPOSE);
    num('DeviceRequestMaxSkewS', device.DEVICE_REQUEST_MAX_SKEW_S);
    num('DeviceNonceTTLS', device.DEVICE_NONCE_TTL_S);
    num('DeviceRequestMaxBytes', device.DEVICE_REQUEST_MAX_BYTES);
    str('RegistrationPurpose', device.REGISTRATION_PURPOSE);
    str('SelfInstalledModel', control.SELF_INSTALLED_MODEL);
    num('PushMaxHandles', device.PUSH_MAX_HANDLES);
    num('PushMaxPerDevicePerMinute', device.PUSH_MAX_PER_DEVICE_PER_MINUTE);
    num('PushMaxPerHandlePerHour', device.PUSH_MAX_PER_HANDLE_PER_HOUR);
    block('Feedback drop delivery (CT-91).');
    num('FeedbackDropTTLS', device.FEEDBACK_DROP_TTL_S);
    num('FeedbackDropLeaseS', device.FEEDBACK_DROP_LEASE_S);
    num('FeedbackDropMaxEnvelopeBytes', device.FEEDBACK_DROP_MAX_ENVELOPE_BYTES);
    num('FeedbackCardMaxBytes', device.FEEDBACK_CARD_MAX_BYTES);
    num('FeedbackCardMaxLifetimeS', device.FEEDBACK_CARD_MAX_LIFETIME_S);
    num('FeedbackCardsMax', device.FEEDBACK_CARDS_MAX);
    num('FeedbackCardsSyncMaxBytes', device.FEEDBACK_CARDS_SYNC_MAX_BYTES);
    num('FeedbackPullMaxDrops', device.FEEDBACK_PULL_MAX_DROPS);
    num('FeedbackPullMinBytes', device.FEEDBACK_PULL_MIN_BYTES);
    num('FeedbackPullMaxBytes', device.FEEDBACK_PULL_MAX_BYTES);
    num('FeedbackPullResponseMaxBytes', device.FEEDBACK_PULL_RESPONSE_MAX_BYTES);
    num('FeedbackPullBusyS', device.FEEDBACK_PULL_BUSY_S);
    num('FeedbackPullS', device.FEEDBACK_PULL_S);
    num('FeedbackAckMax', device.FEEDBACK_ACK_MAX);
    block('Reporter sign-in (CT-164).');
    num('FeedbackReportersPublishMax', device.FEEDBACK_REPORTERS_PUBLISH_MAX);
    block('Shared links (Whombat share-links.md).');
    num('ShareMaxEnvelopeBytes', device.SHARE_MAX_ENVELOPE_BYTES);
    num('SharePutMaxBytes', device.SHARE_PUT_MAX_BYTES);
    num('ShareMaxLifetimeS', device.SHARE_MAX_LIFETIME_S);
    num('SharesPerDeviceMax', device.SHARES_PER_DEVICE_MAX);
    num('ShareIdsMax', device.SHARE_IDS_MAX);
    block('The own address (4.3; Whombat own-address.md).');
    num('KitCredentialsDeclareMax', device.KIT_CREDENTIALS_DECLARE_MAX);
  }
  let extra = '';
  if (pkg === 'release') {
    const t = release.UPDATE_JOURNAL_TRANSITIONS;
    extra = `\n// UpdateJournalTransitions lists the allowed transitions of the manager's update journal (MA-11).\nvar UpdateJournalTransitions = map[UpdateJournalState][]UpdateJournalState{\n${Object.entries(
      t,
    )
      .map(
        ([from, tos]) =>
          `\tUpdateJournalState${goName(from)}: {${tos.map((to) => `UpdateJournalState${goName(to)}`).join(', ')}},`,
      )
      .join('\n')}\n}\n`;
  }
  if (pkg === 'protocol') {
    extra = `\n// AdmissionErrorClose maps an admission failure code to the relay close code (MA-05).\nvar AdmissionErrorClose = map[string]int{\n${Object.entries(
      protocol.ADMISSION_ERROR_CLOSE,
    )
      .map(([code, close]) => `\t${JSON.stringify(code)}: ${close},`)
      .join('\n')}\n}\n`;
  }
  if (pkg === 'local') {
    const statusMap = (doc: string, name: string, map: Readonly<Record<string, number>>) =>
      `\n// ${name} ${doc}\nvar ${name} = map[string]int{\n${Object.entries(map)
        .map(([code, status]) => `\t${JSON.stringify(code)}: ${status},`)
        .join('\n')}\n}\n`;
    extra =
      statusMap(
        'maps a Bluetooth socket error code to its HTTP status (CT-682).',
        'BluetoothSocketErrorStatus',
        local.BLUETOOTH_SOCKET_ERROR_STATUS,
      ) +
      statusMap(
        'maps a support socket error code to its HTTP status (CT-938).',
        'SupportErrorStatus',
        local.SUPPORT_ERROR_STATUS,
      );
  }
  if (pkg === 'device') {
    extra = `\n// DeviceOps lists the device API operations (POST /v1/device/<op>).\nvar DeviceOps = []DeviceOpName{${Object.keys(
      device.DEVICE_OPS,
    )
      .map((op) => `DeviceOpName${goName(op)}`)
      .join(', ')}}\n`;
  }
  return `// Code generated by conformance/src/gen-cross-language.ts from the TypeScript contracts. DO NOT EDIT.

package ${pkg}

const (${lines.join('\n')}
)
${extra}`;
}

export async function generate(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const problems = REGISTRY.flatMap((e) => checkSubset(e.schema, e.name));
  if (problems.length) throw new Error(`outside the cross-language subset:\n${problems.join('\n')}`);
  for (const e of REGISTRY) {
    const text = json(jsonSchemaOf(e.name, e.schema));
    files.set(`schema/${e.name}.json`, text);
    files.set(`go/internal/schemas/json/${e.name}.json`, text);
  }
  for (const [name, data] of Object.entries(await buildVectors())) {
    files.set(`vectors/${name}`, json(data));
    files.set(`go/testdata/vectors/${name}`, json(data));
  }
  const go = generateGo(GO_MODULE);
  for (const pkg of GO_PACKAGES) {
    files.set(`go/${pkg}/types_gen.go`, go[pkg]);
    files.set(`go/${pkg}/constants_gen.go`, constants(pkg));
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await generate();
  for (const dir of ['schema', 'vectors', 'go/internal/schemas/json', 'go/testdata/vectors']) {
    const abs = join(ROOT, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of readdirSync(abs)) if (f.endsWith('.json')) rmSync(join(abs, f));
  }
  for (const [path, text] of files) {
    mkdirSync(join(ROOT, path, '..'), { recursive: true });
    writeFileSync(join(ROOT, path), text);
  }
  const goFiles = [...files.keys()].filter((p) => p.endsWith('.go')).map((p) => join(ROOT, p));
  execFileSync('gofmt', ['-w', ...goFiles], { stdio: 'inherit' });
  console.log(`generated ${files.size} files`);
}
