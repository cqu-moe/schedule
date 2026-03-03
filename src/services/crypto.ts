const IV_LENGTH = 12;

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
    const a = enc.encode(decrypted);
    const b = enc.encode(password);
    if (a.byteLength !== b.byteLength) return false;
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// TODO(#13): 移除明文兼容 — 当所有存量 token 自然轮换为加密格式后，
// 将所有 decryptOrPlaintext() 调用替换为 decrypt()，然后删除此函数。
// 预计部署后 24 小时内完成收敛（token-refresh cron 每小时运行）。
export async function decryptOrPlaintext(
  data: string,
  keyBase64: string,
): Promise<string> {
  try {
    return await decrypt(data, keyBase64);
  } catch {
    return data; // TODO(#13): 明文兼容回退
  }
}
