import { config } from '../config.js';
import { HttpError } from '../utils/http.js';

async function postForm(path, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${config.faceUrl}${path}`, {
      method: 'POST',
      headers: { 'X-Internal-Key': config.faceKey },
      body: form,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw new HttpError(status, data.detail || data.error || 'Face service could not read that image');
    }
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Face recognition service is unavailable');
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeImage(buffer, mode) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), 'face.jpg');
  form.append('mode', mode);
  return postForm('/analyze', form);
}

export async function analyzePair(first, second) {
  const form = new FormData();
  form.append('image1', new Blob([first]), 'one.jpg');
  form.append('image2', new Blob([second]), 'two.jpg');
  return postForm('/analyze-pair', form);
}

export async function faceHealth() {
  try {
    const response = await fetch(`${config.faceUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch {
    return { ok: false };
  }
}
