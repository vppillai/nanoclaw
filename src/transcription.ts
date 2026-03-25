import { logger } from './logger.js';

const WHISPER_URL = 'http://127.0.0.1:8178/inference';

/**
 * Transcribe audio buffer via local whisper.cpp server.
 * Returns trimmed transcript text, or null on failure.
 */
export async function transcribeAudio(
  buffer: Buffer,
): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([buffer], { type: 'audio/ogg' }),
      'voice.ogg',
    );
    formData.append('response_format', 'json');

    const resp = await fetch(WHISPER_URL, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    logger.debug({ err }, 'Whisper transcription failed');
    return null;
  }
}
