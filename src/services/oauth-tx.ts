import { encrypt, decrypt } from "./crypto";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48))); // 64 chars
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function generateState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export interface OAuthTx {
  state: string;
  verifier: string;
  origin: string;
}

/** exp is an ABSOLUTE epoch-ms timestamp (caller passes Date.now()+TTL), so tests can inject time. */
export async function sealTx(tx: OAuthTx, keyBase64: string, expMs: number): Promise<string> {
  return encrypt(JSON.stringify({ ...tx, exp: expMs }), keyBase64);
}

export async function openTx(
  sealed: string,
  keyBase64: string,
  nowMs: number,
): Promise<OAuthTx | null> {
  try {
    const obj = JSON.parse(await decrypt(sealed, keyBase64)) as OAuthTx & { exp: number };
    if (typeof obj.exp !== "number" || nowMs > obj.exp) return null;
    return { state: obj.state, verifier: obj.verifier, origin: obj.origin };
  } catch {
    return null; // decryption failure / tamper / invalid JSON
  }
}
