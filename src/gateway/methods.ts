// =============================================================================
// RPC Method Registry
//
// Extensible registry for gateway RPC methods. Built-in methods are registered
// at creation time. Additional methods can be added via server.registerMethod().
//
// Pattern: a proven server-methods.ts.
// =============================================================================

import type { GatewayConnection } from "./connection.js";
import type { GatewayServer } from "./server.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * RPC method handler. Returns the response payload (or throws for errors).
 * Thrown errors with a `code` property use that as the error code.
 */
export type MethodHandler = (
  conn: GatewayConnection,
  params: unknown,
  server: GatewayServer,
) => Promise<unknown> | unknown;

export interface MethodRegistry {
  register(method: string, handler: MethodHandler): void;
  get(method: string): MethodHandler | undefined;
  list(): string[];
}

// -----------------------------------------------------------------------------
// Error helper
// -----------------------------------------------------------------------------

export class MethodError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MethodError";
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Registry factory
// -----------------------------------------------------------------------------

/**
 * Create a method registry with built-in methods pre-registered.
 * Agent-related methods (chat.send, chat.cancel, session.*) are registered
 * separately via registerAgentMethods() after the agent session manager is set up.
 */
export function createMethodRegistry(): MethodRegistry {
  const handlers = new Map<string, MethodHandler>();

  // -- Built-in: status -------------------------------------------------
  handlers.set("status", (_conn, _params, server) => {
    return {
      version: "0.1.0",
      uptime: process.uptime(),
      connections: server.getConnectionCount(),
      activeSessions: server.getActiveSessionCount(),
    };
  });

  return {
    register(method: string, handler: MethodHandler) {
      handlers.set(method, handler);
    },
    get(method: string) {
      return handlers.get(method);
    },
    list() {
      return Array.from(handlers.keys());
    },
  };
}
