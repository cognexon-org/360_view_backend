import { config } from '../config.js';

export async function callVisionService(body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    const response = await fetch(`${config.VISION_SERVICE_URL}/v1/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vision-secret': config.VISION_SHARED_SECRET
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Vision service failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    return payload as { success: boolean; output: Record<string, unknown> };
  } finally {
    clearTimeout(timeout);
  }
}


export async function callRegistrationService(body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${config.VISION_SERVICE_URL}/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vision-secret': config.VISION_SHARED_SECRET },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Registration service failed (${response.status}): ${JSON.stringify(payload)}`);
    return payload as { transform: Record<string, unknown>; confidence: number; overlap?: number; method: string; diagnostics: Record<string, unknown> };
  } finally { clearTimeout(timeout); }
}
