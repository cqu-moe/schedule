import type { Env } from "../types";

const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";

export async function verifyCaptcha(env: Env, token: string | null): Promise<void> {
  if (env.HCAPTCHA_ENABLED !== "true") return;

  if (!token) {
    throw new CaptchaError("CAPTCHA_REQUIRED");
  }

  try {
    const response = await fetch(HCAPTCHA_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response: token,
        secret: env.HCAPTCHA_SECRET,
      }),
    });

    const data = (await response.json()) as { success?: boolean };
    if (!data.success) {
      throw new CaptchaError("CAPTCHA_FAILED");
    }
  } catch (e) {
    if (e instanceof CaptchaError) throw e;
    console.error(JSON.stringify({ event: "captcha.network_error", error: e instanceof Error ? e.message : String(e), message: "hCaptcha verification network error" }));
    throw new CaptchaError("CAPTCHA_SERVICE_UNAVAILABLE");
  }
}

export class CaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaError";
  }
}
