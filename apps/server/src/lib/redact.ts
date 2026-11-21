/**
 * Keeps credentials out of the request log. Mobile sockets carry their bearer token as `/ws?token=…`
 * (browsers cannot set headers on a WebSocket), OAuth-style callbacks carry a `code` and `state`, and join
 * links an invite token, so the logged URL has those query values replaced (security-fixes.md).
 */
import type { FastifyRequest } from 'fastify';
import { redactUrl } from './redact-url';

export { redactUrl };

/** Fastify's default `req` log serializer, with the URL redacted. */
export function requestSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
