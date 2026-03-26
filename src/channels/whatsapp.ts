import { exec, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, getLatestMessage, setLastGroupSync, storeReaction, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudio } from '../transcription.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private sentAudioIds = new Set<string>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          isGroup,
        );

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // PDF attachment handling
          if (msg.message?.documentMessage?.mimetype === 'application/pdf') {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
              const attachDir = path.join(groupDir, 'attachments');
              fs.mkdirSync(attachDir, { recursive: true });
              const filename = path.basename(
                msg.message.documentMessage.fileName ||
                  `doc-${Date.now()}.pdf`,
              );
              const filePath = path.join(attachDir, filename);
              fs.writeFileSync(filePath, buffer as Buffer);
              const sizeKB = Math.round((buffer as Buffer).length / 1024);
              const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
              const caption = msg.message.documentMessage.caption || '';
              content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
              logger.info(
                { jid: chatJid, filename },
                'Downloaded PDF attachment',
              );
            } catch (err) {
              logger.warn(
                { err, jid: chatJid },
                'Failed to download PDF attachment',
              );
            }
          }

          // Voice message handling — transcribe via local whisper.cpp server
          // Skip bot's own voice messages to avoid a feedback loop
          const audioMsg = msg.message?.audioMessage;
          if (!content && audioMsg?.ptt) {
            // On shared number, fromMe is true for BOTH user and bot messages.
            // Skip bot audio by checking our sent message ID set.
            // On own number, fromMe reliably means "bot sent this".
            if (ASSISTANT_HAS_OWN_NUMBER && msg.key.fromMe) continue;
            if (this.sentAudioIds.has(msg.key.id || '')) {
              this.sentAudioIds.delete(msg.key.id || '');
              continue;
            }
            try {
              const audioBuffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
              );
              const transcript = await transcribeAudio(audioBuffer as Buffer);
              if (transcript) {
                content = `[Voice: ${transcript}]`;
                logger.info(
                  { chatJid, length: transcript.length },
                  'Transcribed voice message',
                );
              } else {
                content =
                  '[Voice message received - transcription unavailable]';
              }
            } catch (err) {
              logger.warn({ err, chatJid }, 'Voice transcription failed');
              content = '[Voice message received - transcription failed]';
            }
          }

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });

    // Listen for message reactions
    this.sock.ev.on('messages.reaction', async (reactions) => {
      for (const { key, reaction } of reactions) {
        try {
          const messageId = key.id;
          if (!messageId) continue;
          const rawChatJid = key.remoteJid;
          if (!rawChatJid || rawChatJid === 'status@broadcast') continue;
          const chatJid = await this.translateJid(rawChatJid);
          const groups = this.opts.registeredGroups();
          if (!groups[chatJid]) continue;
          const reactorJid = reaction.key?.participant || reaction.key?.remoteJid || '';
          const emoji = reaction.text || '';
          const timestamp = reaction.senderTimestampMs
            ? new Date(Number(reaction.senderTimestampMs)).toISOString()
            : new Date().toISOString();
          storeReaction({
            message_id: messageId,
            message_chat_jid: chatJid,
            reactor_jid: reactorJid,
            reactor_name: reactorJid.split('@')[0],
            emoji,
            timestamp,
          });
          logger.info(
            {
              chatJid,
              messageId: messageId.slice(0, 10) + '...',
              reactor: reactorJid.split('@')[0],
              emoji: emoji || '(removed)',
            },
            emoji ? 'Reaction added' : 'Reaction removed',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to process reaction');
        }
      }
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    mediaPath?: string,
  ): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      if (mediaPath && fs.existsSync(mediaPath)) {
        const buffer = fs.readFileSync(mediaPath);
        const ext = mediaPath.split('.').pop()?.toLowerCase();
        if (
          ext === 'jpg' ||
          ext === 'jpeg' ||
          ext === 'png' ||
          ext === 'webp'
        ) {
          await this.sock.sendMessage(jid, {
            image: buffer,
            caption: prefixed || undefined,
          });
          logger.info({ jid, mediaPath, type: 'image' }, 'Image message sent');
        } else if (
          ext === 'mp3' ||
          ext === 'ogg' ||
          ext === 'wav' ||
          ext === 'opus'
        ) {
          // WhatsApp voice notes require OGG/Opus. Convert if needed.
          let audioBuffer = buffer;
          if (ext !== 'ogg' && ext !== 'opus') {
            try {
              const oggPath = mediaPath.replace(/\.[^.]+$/, '.ogg');
              execFileSync(
                'ffmpeg',
                [
                  '-y',
                  '-i',
                  mediaPath,
                  '-c:a',
                  'libopus',
                  '-b:a',
                  '64k',
                  '-vbr',
                  'on',
                  '-application',
                  'voip',
                  '-f',
                  'ogg',
                  oggPath,
                ],
                { timeout: 30000, stdio: 'pipe' },
              );
              audioBuffer = fs.readFileSync(oggPath);
              fs.unlinkSync(oggPath); // clean up temp file
              logger.debug(
                { mediaPath, oggPath },
                'Converted audio to OGG/Opus',
              );
            } catch (err) {
              logger.warn(
                { err, mediaPath },
                'ffmpeg conversion failed, sending as-is',
              );
            }
          }
          const sentAudio = await this.sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
          });
          // Track sent audio ID to prevent feedback loop on shared number
          if (sentAudio?.key?.id) {
            this.sentAudioIds.add(sentAudio.key.id);
          }
          logger.info({ jid, mediaPath, type: 'audio' }, 'Audio message sent');
        } else {
          // Unknown media type — send as document
          await this.sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/octet-stream',
            fileName: mediaPath.split('/').pop() || 'file',
            caption: prefixed || undefined,
          });
          logger.info(
            { jid, mediaPath, type: 'document' },
            'Document message sent',
          );
        }
      } else {
        await this.sock.sendMessage(jid, { text: prefixed });
        logger.info({ jid, length: prefixed.length }, 'Message sent');
      }
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendReaction(
    chatJid: string,
    messageKey: { id: string; remoteJid: string; fromMe?: boolean; participant?: string },
    emoji: string
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ chatJid, emoji }, 'Cannot send reaction - not connected');
      throw new Error('Not connected to WhatsApp');
    }
    try {
      await this.sock.sendMessage(chatJid, {
        react: { text: emoji, key: messageKey },
      });
      logger.info(
        {
          chatJid,
          messageId: messageKey.id?.slice(0, 10) + '...',
          emoji: emoji || '(removed)',
        },
        emoji ? 'Reaction sent' : 'Reaction removed'
      );
    } catch (err) {
      logger.error({ chatJid, emoji, err }, 'Failed to send reaction');
      throw err;
    }
  }

  async reactToLatestMessage(chatJid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(chatJid);
    if (!latest) {
      throw new Error(`No messages found for chat ${chatJid}`);
    }
    const messageKey = {
      id: latest.id,
      remoteJid: chatJid,
      fromMe: latest.fromMe,
    };
    await this.sendReaction(chatJid, messageKey, emoji);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
