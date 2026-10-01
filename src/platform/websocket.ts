/** Bun supports handshake headers; lib.dom's browser constructor does not.
 * Keep the runtime-specific overload at the platform boundary rather than
 * weakening application types or adding browser-global declarations.
 */
export function connectWebSocket(url: string, headers: Record<string, string> = {}): WebSocket {
  const Constructor = globalThis.WebSocket as unknown as {
    new(url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  return new Constructor(url, { headers });
}
