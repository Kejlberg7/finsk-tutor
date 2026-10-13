import { timingSafeEqual } from "node:crypto";

const MIN_TOKEN_LENGTH = 40;

/** Validate a dedicated bearer token without exposing the browser login cookie. */
export function isAuthorizedTutorReadRequest(authorization: string | null, expectedToken = process.env.TUTOR_READ_API_TOKEN): boolean {
  if (!expectedToken || expectedToken.length < MIN_TOKEN_LENGTH || !authorization) return false;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
