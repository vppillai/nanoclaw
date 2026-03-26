---
name: add-pdf-reader
description: Add PDF reading to NanoClaw agents. Extracts text from PDFs via pdftotext CLI. Handles attachments, URLs, and local files.
---

# Add PDF Reader

Adds PDF reading capability to all container agents using poppler-utils (pdftotext/pdfinfo). PDFs sent as attachments are auto-downloaded to the group workspace.

## Phase 1: Pre-flight

1. Check if `container/skills/pdf-reader/pdf-reader` exists — skip to Phase 3 if already applied
2. Confirm Telegram is installed first (`skill/telegram` merged). This skill modifies Telegram channel files.

## Phase 2: Apply Code Changes

### Ensure upstream fork remote

```bash
git remote -v
```



```bash

```

### Merge the skill branch

```bash


  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/skills/pdf-reader/SKILL.md` (agent-facing documentation)
- `container/skills/pdf-reader/pdf-reader` (CLI script)
- `poppler-utils` in `container/Dockerfile`
- PDF attachment download in `src/channels/telegram.ts`
- PDF tests in `src/channels/telegram.test.ts`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm run build
npx vitest run src/channels/telegram.test.ts
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test PDF extraction

Send a PDF file in any registered Telegram chat. The agent should:
1. Download the PDF to `attachments/`
2. Respond acknowledging the PDF
3. Be able to extract text when asked

### Test URL fetching

Ask the agent to read a PDF from a URL. It should use `pdf-reader fetch <url>`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i pdf
```

Look for:
- `Downloaded PDF attachment` — successful download
- `Failed to download PDF attachment` — media download issue

## Troubleshooting

### Agent says pdf-reader command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### PDF text extraction is empty

The PDF may be scanned (image-based). pdftotext only handles text-based PDFs. Consider using the agent-browser to open the PDF visually instead.

### PDF not detected

Verify the message has `documentMessage` with `mimetype: application/pdf`. Some file-sharing apps send PDFs as generic files without the correct mimetype.
