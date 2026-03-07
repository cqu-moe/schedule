import { bufferToBase64 } from "./encoding";

export function generateToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return bufferToBase64(bytes.buffer)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Generate a token guaranteed not to collide with existing tokens.
 * @param collisionChecker - async function that returns true if token exists
 * @param maxRetries - maximum retry attempts (default 5)
 */
export async function generateUniqueToken(
  collisionChecker: (token: string) => Promise<boolean>,
  maxRetries = 5,
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const token = generateToken();
    if (!(await collisionChecker(token))) {
      return token;
    }
  }
  throw new Error("Failed to generate unique token");
}
