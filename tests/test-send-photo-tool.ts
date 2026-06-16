import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  executeSendPhoto,
  sendPhotoToolDefinition,
  setSendPhotoDeps,
  resetSendPhotoDeps,
} from "../src/tools/send_photo.js";
import { ChannelRegistry } from "../src/gateway/channel.js";
import type { ToolContext } from "../src/agent/types.js";
import type { ChannelOutboundAdapter, OutboundSendResult } from "../src/gateway/channel-types.js";

// ---------------------------------------------------------------------------
// send_photo tool unit tests.
//
// The tool uploads a frontend-captured camera frame to Slack via the channel
// adapter (ChannelOutboundAdapter.sendFile). We exercise the tool's logic —
// validation, base64 decode, default-recipient fallback, name resolution, and
// the success path — against a MOCK adapter, so there's no Slack network I/O.
// (Real upload behavior is covered by manual tests with a live workspace.)
// ---------------------------------------------------------------------------

const ctx: ToolContext = {
  session_id: "test",
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
  emit: () => {},
  headless: true,
};

// A 1x1 JPEG (FF D8 FF ... FF D9), base64 — a valid, tiny image payload.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

interface MockOutbound extends ChannelOutboundAdapter {
  files: Array<{ to: string; filename: string; comment?: string; bytes: number }>;
  defaultRecipient: string | null;
  recipients: Array<{ id: string; label: string; kind?: "user" | "channel" }>;
  ready: boolean;
  supportsFile: boolean;
  getDefaultRecipient(): string | null;
  resolveRecipients(q: string): Promise<Array<{ id: string; label: string; kind?: "user" | "channel" }>>;
}

function createMockSlack(opts?: Partial<MockOutbound>): MockOutbound {
  const mock: MockOutbound = {
    channelId: "slack",
    files: [],
    defaultRecipient: "U0DEFAULT01",
    recipients: [],
    ready: true,
    supportsFile: true,
    isReady() { return this.ready; },
    async sendText(): Promise<OutboundSendResult> { return { ok: true, messageId: "m1" }; },
    async stop() {},
    getDefaultRecipient() { return this.defaultRecipient; },
    async resolveRecipients() { return this.recipients; },
    ...(opts as object),
  };
  // sendFile is feature-detected by the tool; allow tests to omit it.
  if (mock.supportsFile) {
    mock.sendFile = async (o) => {
      mock.files.push({ to: o.to, filename: o.filename, comment: o.comment, bytes: o.data.length });
      return { ok: true, messageId: "file1", channelId: o.to };
    };
  } else {
    delete (mock as { sendFile?: unknown }).sendFile;
  }
  return mock;
}

function registryWith(adapter: ChannelOutboundAdapter): ChannelRegistry {
  const r = new ChannelRegistry();
  r.register(adapter);
  return r;
}

afterEach(() => resetSendPhotoDeps());

describe("send_photo tool definition", () => {
  test("is named send_photo, auto-approve, and does not require image_base64 from the model", () => {
    expect(sendPhotoToolDefinition.name).toBe("send_photo");
    expect(sendPhotoToolDefinition.permission).toBe("auto_approve");
    // The frontend attaches the image — the model must not be asked for bytes.
    expect(sendPhotoToolDefinition.input_schema.required ?? []).not.toContain("image_base64");
  });
});

describe("send_photo validation", () => {
  beforeEach(() => resetSendPhotoDeps());

  test("errors when image_base64 is missing", async () => {
    setSendPhotoDeps(registryWith(createMockSlack()));
    const r = await executeSendPhoto({ image_base64: "" } as any, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/image_base64/i);
  });

  test("errors when base64 decodes to no bytes", async () => {
    setSendPhotoDeps(registryWith(createMockSlack()));
    // A string of only base64-invalid chars decodes to an empty Buffer → no image.
    const r = await executeSendPhoto({ image_base64: "@@@@" } as any, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/decode|image data/i);
  });

  test("errors when channel registry is not injected", async () => {
    // deps reset in beforeEach → no registry.
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64 }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/not available in this context/i);
  });

  test("errors when the adapter is not ready", async () => {
    setSendPhotoDeps(registryWith(createMockSlack({ ready: false })));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64 }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/not ready/i);
  });

  test("errors when the adapter cannot upload files", async () => {
    setSendPhotoDeps(registryWith(createMockSlack({ supportsFile: false })));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64 }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/does not support file uploads/i);
  });

  test("errors when no destination and no default recipient configured", async () => {
    setSendPhotoDeps(registryWith(createMockSlack({ defaultRecipient: null })));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64 }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/no default recipient/i);
  });
});

describe("send_photo delivery", () => {
  beforeEach(() => resetSendPhotoDeps());

  test("uploads to the default DM when no `to` is given", async () => {
    const slack = createMockSlack({ defaultRecipient: "U0ME0000001" });
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64 }, ctx);
    expect(r.type).toBe("text");
    expect(slack.files).toHaveLength(1);
    expect(slack.files[0].to).toBe("U0ME0000001");
    expect(slack.files[0].bytes).toBeGreaterThan(0);
    expect(slack.files[0].filename).toBe("photo.jpg"); // JPEG magic bytes sniffed
  });

  test("passes an explicit channel id straight through (no name lookup)", async () => {
    const slack = createMockSlack();
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64, to: "C0TEAM00001", comment: "look!" }, ctx);
    expect(r.type).toBe("text");
    expect(slack.files[0].to).toBe("C0TEAM00001");
    expect(slack.files[0].comment).toBe("look!");
  });

  test("fuzzy-resolves a person's name to a user id", async () => {
    const slack = createMockSlack({ recipients: [{ id: "U0XINKAI001", label: "Xinkai Zou", kind: "user" }] });
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64, to: "xinkai" }, ctx);
    expect(r.type).toBe("text");
    expect(slack.files[0].to).toBe("U0XINKAI001");
  });

  test("returns candidates (does not send) when a name is ambiguous", async () => {
    const slack = createMockSlack({
      recipients: [
        { id: "U0AAAAAAAA1", label: "Alex A", kind: "user" },
        { id: "U0BBBBBBBB1", label: "Alex B", kind: "user" },
      ],
    });
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64, to: "alex" }, ctx);
    expect(r.type).toBe("text");
    expect((r.metadata as any)?.ambiguous).toBe(true);
    expect(slack.files).toHaveLength(0); // nothing sent on ambiguity
  });

  test("surfaces an upload failure from the adapter as an error", async () => {
    const slack = createMockSlack();
    slack.sendFile = async () => ({ ok: false, error: "channel_not_found" });
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: TINY_JPEG_B64, to: "C0BAD000001" }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/channel_not_found/);
  });

  test("tolerates a data: URL prefix on the image", async () => {
    const slack = createMockSlack({ defaultRecipient: "U0ME0000001" });
    setSendPhotoDeps(registryWith(slack));
    const r = await executeSendPhoto({ image_base64: `data:image/jpeg;base64,${TINY_JPEG_B64}` }, ctx);
    expect(r.type).toBe("text");
    expect(slack.files[0].bytes).toBeGreaterThan(0);
  });
});
