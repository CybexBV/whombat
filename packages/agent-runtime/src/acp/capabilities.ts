/**
 * What an ACP agent (Hermes) negotiated in `initialize`: only what it advertised counts; `false` means unsupported.
 */
import type { InitializeResponse } from '@agentclientprotocol/sdk';

/** The protocol version Whombat speaks (`@agentclientprotocol/sdk` `PROTOCOL_VERSION`). */
export const ACP_PROTOCOL_VERSION = 1;

/** `initialize`'s answer as Whombat uses it. */
export interface AcpNegotiated {
  protocolVersion: number;
  /** `hermes-agent 0.22.5`, as the agent named itself; null when it didn't. */
  agent: string | null;
  loadSession: boolean;
  resumeSession: boolean;
  image: boolean;
  embeddedContext: boolean;
}

export function negotiatedFrom(init: InitializeResponse): AcpNegotiated {
  const caps = init.agentCapabilities ?? {};
  const info = init.agentInfo;
  const agent = info ? `${info.name}${info.version ? ` ${info.version}` : ''}`.slice(0, 120) : null;
  return {
    protocolVersion: init.protocolVersion,
    agent,
    loadSession: caps.loadSession === true,
    resumeSession: Boolean(caps.sessionCapabilities?.resume),
    image: caps.promptCapabilities?.image === true,
    embeddedContext: caps.promptCapabilities?.embeddedContext === true,
  };
}
