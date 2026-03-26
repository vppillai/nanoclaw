---
name: tts
description: Convert text to speech audio using MiniMax speech HD. Use when the user asks you to say something as audio, read something aloud, send a voice message, or speak. After generating, send the audio using send_message with media_path.
allowed-tools: Bash(tts:*)
---

# Text-to-Speech

## Quick start

```bash
# Generate speech and get the file path
tts speak "Hello, how are you doing today?"

# With a specific voice
tts speak "Good morning everyone" --voice English_Graceful_Lady

# Faster speed
tts speak "Breaking news" --speed 1.3

# List available voices
tts voices
```

## Workflow: Generate and send voice message

**Step 1:** Generate the audio:

```bash
tts speak "Your text here" --voice English_Trustworth_Man
```

This prints the output file path (e.g., `attachments/tts-1234567890-abcd.mp3`).

**Step 2:** Send it to the user using `send_message` with `media_path`:

Use the MCP tool `send_message` with:
- `text`: Brief description (optional for audio)
- `media_path`: The full path from step 1 (prefix with `/workspace/group/` if relative)

Audio files are sent as voice messages automatically.

## Voice selection

If the user asks for a specific voice style (e.g. "use a female voice", "deep voice", "cheerful"), pick the best match from the list below. If no preference is given, the default voice is used (configurable via `TTS_DEFAULT_VOICE` env var, defaults to `English_Trustworth_Man`).

| Voice ID | Style |
|----------|-------|
| `English_Trustworth_Man` | Calm, reliable male |
| `English_Graceful_Lady` | Elegant, professional female |
| `English_FriendlyPerson` | Warm, conversational |
| `English_expressive_narrator` | Storytelling, narration |
| `English_Upbeat_Woman` | Energetic, cheerful female |
| `English_CalmWoman` | Relaxing, soothing female |
| `English_ManWithDeepVoice` | Deep, authoritative male (default) |
| `English_PlayfulGirl` | Light, cheerful female |
| `English_Comedian` | Humorous delivery |
| `English_ConfidentWoman` | Strong, assured female |
| `English_PatientMan` | Steady, patient male |
| `English_magnetic_voiced_man` | Rich, attractive male |
| `English_radiant_girl` | Bright, youthful female |

Run `tts voices` for the full list. Any voice ID from `tts voices` can be passed via `--voice`.
