---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `qwibitai/nanoclaw` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned NanoClaw directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `qwibitai/nanoclaw` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case C — both `origin` (user's fork) and `upstream` (qwibitai) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `qwibitai/nanoclaw.git`.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 4b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Anthropic Credentials

Credentials are stored in `.env` (encrypted with git-crypt if configured) and passed to containers via environment variables. The `.env` file is shadowed inside containers so agents cannot read it directly.

Check if `.env` already has credentials:
```bash
grep -q 'ANTHROPIC_API_KEY' .env 2>/dev/null && echo "KEY_EXISTS" || echo "KEY_MISSING"
grep -q 'ANTHROPIC_BASE_URL' .env 2>/dev/null && echo "URL_EXISTS" || echo "URL_MISSING"
```

If both exist, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: How do you want to connect to Claude?

1. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com. Set ANTHROPIC_BASE_URL=https://api.anthropic.com"
2. **Third-party provider** — description: "Use a compatible API endpoint (e.g. MiniMax, AWS Bedrock). You'll provide the base URL and API key."

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Once they provide the key, write it to `.env`:
```bash
# Create .env from example if it doesn't exist
[ -f .env ] || cp .env.example .env

# Set the credentials (use sed to update existing or append)
grep -q 'ANTHROPIC_BASE_URL=' .env && sed -i 's|^ANTHROPIC_BASE_URL=.*|ANTHROPIC_BASE_URL=https://api.anthropic.com|' .env || echo 'ANTHROPIC_BASE_URL=https://api.anthropic.com' >> .env
grep -q 'ANTHROPIC_API_KEY=' .env && sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=<key>|" .env || echo "ANTHROPIC_API_KEY=<key>" >> .env
chmod 600 .env
```

### Third-party provider path

Collect the base URL and API key. Common providers:
- MiniMax: `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`
- Also collect `AGENT_MODEL` if the provider uses a different model name.

Write all values to `.env` as above.

### After either path

Verify credentials work by running a quick container test:
```bash
echo '{"prompt":"Say hi","groupFolder":"test","chatJid":"test@test","isMain":false}' | docker run -i -e ANTHROPIC_BASE_URL=<url> -e ANTHROPIC_API_KEY=<key> nanoclaw-agent:latest
```

If the test returns a response, credentials are working. If it shows "Not logged in", the key or URL is wrong.

### Optional: git-crypt encryption

AskUserQuestion: Do you want to encrypt `.env` in your git repo using git-crypt?

If yes:
```bash
sudo apt-get install -y git-crypt   # or brew install git-crypt
git-crypt init
# .gitattributes already has .env filter rules
git-crypt export-key .git-crypt-key
git add .env && git commit -m "Add encrypted .env"
```
Tell user to back up `.git-crypt-key` securely — it's needed to unlock on other machines.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 7a. Headless Server Hardening (Linux only)

**Skip this step on macOS or if the user is running a desktop environment they want to keep.**

Detect if this is a headless server (no monitor, Raspberry Pi, VPS):
```bash
# Check if running on Raspberry Pi
IS_RPI=$(grep -q 'Raspberry Pi\|BCM2' /proc/cpuinfo 2>/dev/null && echo "true" || echo "false")
# Check if any display server is running
HAS_DISPLAY=$(pgrep -x "Xorg\|labwc\|sway\|gnome-shell" > /dev/null 2>&1 && echo "true" || echo "false")
```

AskUserQuestion: Is this a headless server (no monitor attached)?

If yes, run the following optimizations:

### Remove desktop/GUI packages
```bash
sudo apt-get purge -y \
  chromium chromium-common chromium-l10n chromium-sandbox \
  firefox \
  vlc vlc-bin vlc-data vlc-l10n 'vlc-plugin-*' \
  thonny \
  libreoffice* \
  lightdm lightdm-gtk-greeter \
  rpd-wayland-core rpd-wayland-extras \
  labwc wf-panel-pi \
  xserver-xorg xserver-xorg-core 'xserver-xorg-*' xwayland \
  cups cups-browsed cups-common \
  modemmanager \
  cloud-init \
  nfs-common \
  bluez \
  pipewire pipewire-pulse \
  2>/dev/null
sudo apt-get autoremove -y
sudo apt-get clean
```

### Disable unnecessary services
```bash
sudo systemctl disable --now \
  lightdm cups cups-browsed bluetooth ModemManager \
  nfs-blkmap rpcbind udisks2 \
  cloud-init cloud-init-local cloud-config cloud-final cloud-init-network cloud-init-main \
  wayvnc-control glamor-test rp1-test \
  cups.socket rpcbind.socket cups.path cloud-init-hotplugd.socket \
  serial-getty@ttyAMA10 getty@tty1 \
  2>/dev/null
```

### Set boot target to multi-user (no GUI)
```bash
sudo systemctl set-default multi-user.target
```

### Reduce GPU memory (headless — no display)
```bash
grep -q 'gpu_mem=' /boot/firmware/config.txt || echo 'gpu_mem=16' | sudo tee -a /boot/firmware/config.txt
```

### Disable WiFi power management (prevents WiFi hangs)
```bash
sudo tee /etc/NetworkManager/conf.d/wifi-powersave-off.conf << 'EOF'
[connection]
wifi.powersave = 2
EOF
```

### Configure hardware watchdog (auto-reboot on kernel hang)
```bash
sudo mkdir -p /etc/systemd/system.conf.d
sudo tee /etc/systemd/system.conf.d/watchdog.conf << 'EOF'
[Manager]
RuntimeWatchdogSec=30
RebootWatchdogSec=10min
WatchdogDevice=/dev/watchdog0
EOF
```

### Network watchdog (reboot on sustained network loss)
```bash
sudo tee /usr/local/bin/network-watchdog.sh << 'SCRIPT'
#!/bin/bash
COUNTER_FILE=/tmp/network-watchdog-failures
GATEWAY=$(ip route | awk '/default/ {print $3}' | head -1)
if ping -c 3 -W 5 "$GATEWAY" > /dev/null 2>&1; then
    echo 0 > "$COUNTER_FILE"
    exit 0
fi
FAILURES=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
FAILURES=$((FAILURES + 1))
echo $FAILURES > "$COUNTER_FILE"
logger -t network-watchdog "Network unreachable, failure count: $FAILURES"
if [ "$FAILURES" -ge 5 ]; then
    logger -t network-watchdog "5 consecutive failures, rebooting"
    /sbin/reboot
fi
SCRIPT
sudo chmod +x /usr/local/bin/network-watchdog.sh
```

### Limit journal size
```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size.conf << 'EOF'
[Journal]
SystemMaxUse=100M
MaxRetentionSec=7day
EOF
```

### Set up maintenance cron jobs
```bash
# Network watchdog every minute, docker prune weekly, weekly reboot
(crontab -l 2>/dev/null; echo '* * * * * /usr/local/bin/network-watchdog.sh') | sort -u | crontab -
(crontab -l 2>/dev/null; echo '0 3 * * 0 docker system prune -f --filter "until=168h" >> /tmp/docker-prune.log 2>&1') | sort -u | crontab -
(crontab -l 2>/dev/null; echo '30 3 * * 0 sudo /sbin/reboot') | sort -u | crontab -
```

### Raspberry Pi specific: EEPROM auto-power-on
If `IS_RPI=true`, configure the Pi to automatically restart after power loss or `reboot` command (no button press needed):
```bash
sudo tee /tmp/eeprom-update.conf << 'EOF'
[all]
BOOT_UART=1
BOOT_ORDER=0xf461
POWER_OFF_ON_HALT=0
WAKE_ON_GPIO=0
EOF
sudo rpi-eeprom-config --apply /tmp/eeprom-update.conf
```

### Install avahi for mDNS hostname resolution
```bash
sudo apt-get install -y avahi-daemon avahi-utils
sudo systemctl enable --now avahi-daemon
```

### Enable user lingering (services start at boot without login)
```bash
sudo loginctl enable-linger $USER
```

After all hardening steps, tell the user a reboot is needed to apply GPU memory, EEPROM, and WiFi changes. **Ask user for confirmation before rebooting** — they may have other work in progress.

## 7b. Whisper.cpp Voice Transcription (Linux)

Set up local speech-to-text so voice messages are transcribed automatically. Runs as a systemd service — model loads once and stays in RAM.

### Check if already installed

```bash
which whisper-server 2>/dev/null && echo "INSTALLED" || echo "MISSING"
systemctl --user is-active whisper 2>/dev/null || echo "NOT_RUNNING"
```

If both are OK, skip to step 8.

### Build whisper.cpp from source

```bash
sudo apt-get install -y cmake build-essential
cd /opt/nanoclaw
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON
cmake --build build -j$(nproc) --target whisper-server
sudo cp build/bin/whisper-server /usr/local/bin/
cd /opt/nanoclaw/nanoclaw
```

### Download model

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

The `base` model (148MB) is a good balance of speed and accuracy on Pi 5. For faster but less accurate: `ggml-tiny.bin` (77MB). For better accuracy: `ggml-small.bin` (466MB).

### Create systemd service

```bash
cat << 'EOF' > ~/.config/systemd/user/whisper.service
[Unit]
Description=Whisper.cpp Speech-to-Text Server
Before=nanoclaw.service

[Service]
Type=simple
ExecStart=/usr/local/bin/whisper-server -m /opt/nanoclaw/nanoclaw/data/models/ggml-base.bin --host 127.0.0.1 --port 8178 --convert
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now whisper
```

### Update NanoClaw service to depend on whisper

Ensure the nanoclaw service starts after whisper:

```bash
sed -i 's/After=network-online.target docker.service/After=network-online.target docker.service whisper.service/' \
  ~/.config/systemd/user/nanoclaw.service
sed -i 's/Wants=network-online.target/Wants=network-online.target whisper.service/' \
  ~/.config/systemd/user/nanoclaw.service
systemctl --user daemon-reload
```

### Verify

```bash
# Test the server responds
curl -s -X POST http://127.0.0.1:8178/inference \
  -F "file=@<any-audio-file>" -F "response_format=json"
```

Boot order is now: `docker` → `whisper` → `nanoclaw`.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `grep ANTHROPIC_API_KEY .env`)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing API key in `.env` (re-run step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`


## 9. Diagnostics

1. Use the Read tool to read `.claude/skills/setup/diagnostics.md`.
2. Follow every step in that file before completing setup.
