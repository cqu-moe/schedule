import { bufferToBase64 } from "../utils/encoding";

const IV_LENGTH = 12;

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const rawKey = base64ToBuffer(keyBase64);
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  // Concatenate IV + ciphertext
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);

  return bufferToBase64(combined.buffer);
}

export async function decrypt(
  data: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const combined = new Uint8Array(base64ToBuffer(data));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

export async function verifyPassword(
  password: string,
  encrypted: string,
  keyBase64: string,
): Promise<boolean> {
  try {
    const decrypted = await decrypt(encrypted, keyBase64);
    const enc = new TextEncoder();
    const [hashA, hashB] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(decrypted)),
      crypto.subtle.digest("SHA-256", enc.encode(password)),
    ]);
    return crypto.subtle.timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}
