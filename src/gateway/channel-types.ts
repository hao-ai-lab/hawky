// =============================================================================
// Channel Adapter Types
//
// Extensible interfaces for messaging app integrations (Slack, iMessage, etc.).
// Simplified from a proven 20+ adapter types to 3 core interfaces:
// outbound (send), inbound (receive), and health status.
// =============================================================================

// -----------------------------------------------------------------------------
// Outbound — send messages from Hawky to external apps
// -----------------------------------------------------------------------------

export interface ChannelOutboundAdapter {
  readonly channelId: string;

  /** Whether the adapter is connected and ready to send. */
  isReady(): boolean;

  /** Send a text message through the channel. */
  sendText(opts: {
    /** Recipient: user ID, channel ID, or conversation ID. */
    to: string;
    /** Message text. */
    text: string;
    /** Thread ID for threaded replies (platform-specific). */
    threadId?: string;
    /** Which identity to use. Default: "bot". */
    identity?: "bot" | "user";
  }): Promise<OutboundSendResult>;

  /**
   * Upload a binary file (e.g. a photo) to the channel. Optional — adapters that
   * don't support file uploads omit it, and callers should feature-detect.
   */
  sendFile?(opts: {
    /** Recipient: user ID, channel ID, or conversation ID. */
    to: string;
    /** Raw file bytes. */
    data: Buffer;
    /** Filename shown in the channel (e.g. "photo.jpg"). */
    filename: string;
    /** Optional message/caption posted alongside the file. */
    comment?: string;
    /** Thread ID for threaded replies (platform-specific). */
    threadId?: string;
  }): Promise<OutboundSendResult>;

  /** Gracefully shut down the outbound connection. */
  stop(): Promise<void>;
}

export interface OutboundSendResult {
  ok: boolean;
  messageId?: string;
  channelId?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Inbound — receive messages from external apps
// -----------------------------------------------------------------------------

export interface ChannelInboundAdapter {
  readonly channelId: string;

  /** Start listening for inbound messages. */
  start(): Promise<void>;

  /** Register a handler for inbound messages. */
  onMessage(handler: InboundMessageHandler): void;

  /** Gracefully shut down the inbound listener. */
  stop(): Promise<void>;
}

export type InboundMessageHandler = (msg: InboundMessage) => void;

export interface InboundMessage {
  /** Channel identifier (e.g., "slack"). */
  channelId: string;
  /** Platform conversation ID (e.g., Slack DM channel ID). */
  conversationId: string;
  /** Thread ID for threaded conversations (platform-specific). */
  threadId?: string;
  /** Sender's platform user ID. */
  senderId: string;
  /** Sender's display name (if available). */
  senderName?: string;
  /** Message text content. */
  text: string;
  /** Message timestamp (epoch ms). */
  timestamp: number;
  /** Raw platform event (for debugging/advanced use). */
  raw?: unknown;
}

// -----------------------------------------------------------------------------
// Combined adapter — most channels implement both directions
// -----------------------------------------------------------------------------

export interface ChannelAdapter extends ChannelOutboundAdapter, ChannelInboundAdapter {}

// -----------------------------------------------------------------------------
// Health status
// -----------------------------------------------------------------------------

export interface ChannelStatus {
  channelId: string;
  connected: boolean;
  lastEventAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
}
