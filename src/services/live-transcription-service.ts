import WebSocket from 'ws';
import { Config } from '../config';
import { TextChannel } from 'discord.js';

interface PendingTranscript {
  username: string;
  text: string;
  timestamp: number;
}

/**
 * Manages real-time transcription for a recording session.
 * Opens one Deepgram WebSocket per speaker, buffers results,
 * and posts batched transcripts to a Discord text channel.
 */
export class LiveTranscriptionService {
  private connections: Map<string, WebSocket> = new Map(); // userId -> WS
  private keepAliveTimers: Map<string, NodeJS.Timeout> = new Map(); // userId -> keepalive interval
  private userNames: Map<string, string> = new Map(); // userId -> display name
  private textChannel: TextChannel;
  private buffer: PendingTranscript[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  // Buffer transcripts for this many ms before posting
  private static FLUSH_INTERVAL_MS = 3000;
  // Max characters per Discord message
  private static MAX_MESSAGE_LENGTH = 1900;

  constructor(textChannel: TextChannel) {
    this.textChannel = textChannel;
  }

  /**
   * Resolve a Discord user ID to a display name.
   */
  async resolveUsername(userId: string): Promise<string> {
    if (this.userNames.has(userId)) return this.userNames.get(userId)!;

    try {
      const { getClient } = require('../client');
      const client = getClient();
      const guild = this.textChannel.guild;
      const member = await guild.members.fetch(userId);
      const name = member.displayName || member.user.username;
      this.userNames.set(userId, name);
      return name;
    } catch {
      const fallback = `User ${userId.slice(-4)}`;
      this.userNames.set(userId, fallback);
      return fallback;
    }
  }

  /**
   * Open a Deepgram streaming WebSocket for a user and return
   * a writable callback to send PCM audio data.
   */
  async openStreamForUser(userId: string): Promise<(pcmChunk: Buffer) => void> {
    // If we already have an open connection for this user (e.g. opus stream
    // auto-closed and re-subscribed), reuse it
    const existing = this.connections.get(userId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      console.log(`[LiveTranscription] Reusing existing Deepgram stream for user ${userId}`);
      this.startKeepAliveTimer(userId, existing);
      return (pcmChunk: Buffer) => {
        if (existing.readyState === WebSocket.OPEN) {
          existing.send(pcmChunk);
          this.resetKeepAliveTimer(userId, existing);
        }
      };
    }

    const username = await this.resolveUsername(userId);

    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '2',
      punctuate: 'true',
      smart_format: String(Config.DEEPGRAM_SMART_FORMAT),
      interim_results: 'false',
    });
    if (Config.DEEPGRAM_LANGUAGE) params.set('language', Config.DEEPGRAM_LANGUAGE);

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${Config.DEEPGRAM_API_KEY}`,
      },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[LiveTranscription] Deepgram WS timeout for ${username}`));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        console.log(`[LiveTranscription] Deepgram stream opened for ${username}`);
        this.connections.set(userId, ws);
        this.startFlushTimer();

        // Start a keepalive timer — if no audio arrives for 8s, send
        // Deepgram a KeepAlive so it doesn't close the WS (its timeout is ~12s).
        this.startKeepAliveTimer(userId, ws);

        resolve((pcmChunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(pcmChunk);
            // Reset the keepalive timer on every audio send
            this.resetKeepAliveTimer(userId, ws);
          }
        });
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'Results' && msg.is_final && msg.channel?.alternatives?.[0]) {
            const transcript = msg.channel.alternatives[0].transcript?.trim();
            if (transcript) {
              this.buffer.push({
                username,
                text: transcript,
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          console.error('[LiveTranscription] Error parsing Deepgram message:', err);
        }
      });

      ws.on('error', (err) => {
        console.error(`[LiveTranscription] Deepgram WS error for ${username}:`, err.message);
      });

      ws.on('close', (code, reason) => {
        console.log(`[LiveTranscription] Deepgram stream closed for ${username}: ${code} ${reason}`);
        this.connections.delete(userId);
        this.clearKeepAliveTimer(userId);
      });
    });
  }

  // --- Deepgram KeepAlive management ---
  // Deepgram closes the WS if it receives no audio data within ~12s.
  // We send a KeepAlive JSON message every 8s of silence to prevent that.

  private static KEEPALIVE_INTERVAL_MS = 8000;

  private startKeepAliveTimer(userId: string, ws: WebSocket): void {
    this.clearKeepAliveTimer(userId);
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch {}
      } else {
        this.clearKeepAliveTimer(userId);
      }
    }, LiveTranscriptionService.KEEPALIVE_INTERVAL_MS);
    this.keepAliveTimers.set(userId, timer);
  }

  private resetKeepAliveTimer(userId: string, ws: WebSocket): void {
    // Restart the timer — we just sent audio so the next keepalive
    // should be KEEPALIVE_INTERVAL_MS from now, not from the last reset.
    this.startKeepAliveTimer(userId, ws);
  }

  private clearKeepAliveTimer(userId: string): void {
    const timer = this.keepAliveTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.keepAliveTimers.delete(userId);
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[LiveTranscription] Flush error:', err);
      });
    }, LiveTranscriptionService.FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const items = this.buffer.splice(0);

    // Group consecutive lines by same speaker
    const lines: string[] = [];
    let lastUser = '';
    for (const item of items) {
      if (item.username !== lastUser) {
        lines.push(`**${item.username}:** ${item.text}`);
        lastUser = item.username;
      } else {
        // Append to last line
        lines[lines.length - 1] += ` ${item.text}`;
      }
    }

    // Split into Discord-safe messages
    let message = '';
    for (const line of lines) {
      if (message.length + line.length + 1 > LiveTranscriptionService.MAX_MESSAGE_LENGTH) {
        if (message) {
          await this.postToChannel(message);
          message = '';
        }
      }
      message += (message ? '\n' : '') + line;
    }
    if (message) {
      await this.postToChannel(message);
    }
  }

  private async postToChannel(content: string): Promise<void> {
    try {
      await this.textChannel.send(content);
    } catch (err) {
      console.error('[LiveTranscription] Failed to post to channel:', err);
    }
  }

  /**
   * Close a single user's Deepgram WebSocket (e.g. when their opus stream ends).
   */
  closeStreamForUser(userId: string): void {
    this.clearKeepAliveTimer(userId);
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
    }
    this.connections.delete(userId);
  }

  /**
   * Close all Deepgram WebSockets and flush remaining buffer.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Clear all keepalive timers
    for (const [userId] of this.keepAliveTimers) {
      this.clearKeepAliveTimer(userId);
    }

    // Send close signal to each Deepgram WS
    for (const [userId, ws] of this.connections) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          // Deepgram expects a JSON close message
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {}
    }

    // Wait a moment for final results to come in
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Flush remaining buffer
    await this.flush();

    // Force close any remaining connections
    for (const [userId, ws] of this.connections) {
      try {
        ws.close();
      } catch {}
    }
    this.connections.clear();

    console.log('[LiveTranscription] All streams closed');
  }
}
