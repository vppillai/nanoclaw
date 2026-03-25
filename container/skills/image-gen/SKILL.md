---
name: image-gen
description: Generate images from text prompts using MiniMax image-01. Use when the user asks you to create, draw, generate, or make an image, picture, photo, illustration, or artwork. After generating, send the image using send_message with media_path.
allowed-tools: Bash(image-gen:*)
---

# Image Generation

## Quick start

```bash
# Generate an image and get the file path
image-gen generate "A golden retriever playing in autumn leaves"

# With aspect ratio
image-gen generate "Mountain landscape at sunset" --aspect 16:9

# Custom output path
image-gen generate "Abstract art" --output attachments/abstract.jpg
```

## Workflow: Generate and send an image

**Step 1:** Generate the image:

```bash
image-gen generate "your prompt here" --aspect 1:1
```

This prints the output file path (e.g., `attachments/img-1234567890-abcd.jpg`).

**Step 2:** Send it to the user using `send_message` with `media_path`:

Use the MCP tool `send_message` with:
- `text`: A caption describing the image
- `media_path`: The full path from step 1 (prefix with `/workspace/group/` if relative)

Example: if image-gen outputs `attachments/img-123.jpg`, use media_path `/workspace/group/attachments/img-123.jpg`.

## Aspect ratios

| Ratio | Best for |
|-------|----------|
| `1:1` | Square (default) — social media, icons |
| `16:9` | Widescreen — landscapes, presentations |
| `4:3` | Standard — general purpose |
| `3:2` | Photo — classic photography |
| `2:3` | Portrait — vertical photos |
| `3:4` | Portrait — vertical general |
| `9:16` | Phone — mobile wallpapers, stories |

## Tips for good prompts

- Be specific: "A red fox sitting in snow under northern lights" > "a fox"
- Include style: "watercolor painting of...", "photorealistic...", "digital art..."
- Mention lighting: "golden hour", "dramatic lighting", "soft diffused light"
- Add mood: "serene", "dramatic", "whimsical", "moody"
