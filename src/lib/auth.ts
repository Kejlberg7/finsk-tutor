import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE = "finsk_tutor_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function getSecret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET skal være mindst 32 tegn.");
  }
  return new TextEncoder().encode(value);
}

export async function getSession(): Promise<boolean> {
  const token = (await cookies()).get(COOKIE)?.value;
  return verifySessionToken(token);
}

/**
 * Route handlers receive the authoritative request headers. Reading the
 * cookie from the request avoids depending on Next's ambient cookie store in
 * serverless API invocations.
 */
export async function getSessionFromRequest(request: Request): Promise<boolean> {
  const token = readCookie(request.headers.get("cookie"), COOKIE);
  return verifySessionToken(token);
}

async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export async function signIn(password: string): Promise<boolean> {
  if (!process.env.TUTOR_PASSWORD || password !== process.env.TUTOR_PASSWORD) return false;
  const token = await new SignJWT({ role: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(getSecret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return true;
}
