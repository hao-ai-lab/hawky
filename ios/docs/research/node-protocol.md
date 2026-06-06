# Hawky node protocol — research for Hawky NodeRunner MVP

Date: 2026-04-19
Target: `feat/node-mvp` on `Hawky`
Source tree: `~/Projects/ambient/hawky` (`src/gateway`, `src/node`)

## TL;DR

A Hawky node is **the same WebSocket connection as a client**, on the same
`/ws` path, authenticated with the same device JWT, using the same `connect`
RPC method. The only difference is `params.role = "node"` plus a
`params.node = { nodeId, name, commands }` bundle. Once registered, the
gateway pushes `node.invoke.request` events and the node answers with an
`RPC` named `node.invoke.result`.

This means **Hawky can act as a node using the token already stored in
Keychain for its client role** — no new auth endpoint, no CLI-only
enrollment. The node and client roles run on **separate WS connections**
though, because the same physical connection is either client-bound to a
session or node-bound to the registry, not both.

## Key files & line citations

### Protocol surface

- `hawky/src/gateway/protocol.ts:47-66` — `ConnectParams` shape; the
  `role?: "client" | "node"` field and the optional `node: { nodeId, name,
  commands }` bundle live here.
- `hawky/src/gateway/protocol.ts:68-72` — `HelloPayload` (`connId`,
  `serverVersion`, `methods`). Identical for both roles.
- `hawky/src/gateway/protocol.ts:16-41` — 3 frame types: `req`, `res`,
  `event`. No node-specific frame envelope; everything rides the generic
  JSON-RPC-ish protocol.

### Handshake (gateway side)

- `hawky/src/gateway/server.ts:441-445` — the `connect` method is routed
  specially, before method dispatch.
- `hawky/src/gateway/server.ts:451-470` — token validation. `deviceAuth.isValid(token)`
  is called the same way regardless of role; a rejected token closes with
  code **1008**.
- `hawky/src/gateway/server.ts:472-487` — role/nodeId recorded on the
  `GatewayConnection`; `role="node"` with missing `node.nodeId` or
  `node.name` is rejected with `INVALID_REQUEST` and close 1008.
- `hawky/src/gateway/server.ts:489-502` — if role=node, call
  `_nodeRegistry.register(conn, {...})`. If role=client, `conn.bindSession`.
  **Session binding is skipped for nodes**; nodes are not addressable by
  sessionKey.
- `hawky/src/gateway/server.ts:504-516` — hello response sent last,
  including `methods` list. Happens AFTER node registration, so by the time
  the node sees the hello it is already dispatchable.

### Node registry lifecycle

- `hawky/src/gateway/node-registry.ts:20-35` — `NodeEntry` shape;
  `connectedAt` is the only timestamp the registry tracks.
- `hawky/src/gateway/node-registry.ts:124-177` — `register()`. If the
  `nodeId` is already connected on a different conn, the old connection is
  closed with **code 4001 "replaced by new connection"** and its pending
  invokes rejected. The new conn wins.
- `hawky/src/gateway/node-registry.ts:183-204` — `unregister()` runs on
  WebSocket close, rejects pending invokes, emits a system message to
  sessions.
- `hawky/src/gateway/node-registry.ts:95-107` — gateway broadcasts a
  `tick` event every 30 s. Nodes use it as a liveness probe; absence for
  2× the interval = reconnect.
- **No explicit node-side heartbeat required.** The node just listens for
  ticks. There is no `node.heartbeat` method.

### Invoke semantics (the round trip)

- `hawky/src/gateway/node-registry.ts:239-300` — gateway-side invoke.
  The gateway allocates a UUID invoke id, sets a 30 s default timeout, then
  sends an **event frame** (not a req) named `node.invoke.request` with
  payload `{ id, command, paramsJSON, timeoutMs }`. Note `paramsJSON` is a
  **JSON-encoded string**, not an object. Field is omitted when params are
  undefined.
- `hawky/src/gateway/node-registry.ts:306-321` — cancel via event
  `node.invoke.cancel` carrying `{ id }`.
- `hawky/src/gateway/node-registry.ts:347-390` — gateway handles the
  reply. The reply is **an RPC request (`type: "req"`) from node to
  gateway**, method `node.invoke.result`, with params
  `{ id, nodeId, ok, payloadJSON?, error? }`. Note `payloadJSON` is again a
  JSON-encoded string. Sender nodeId is cross-checked against the invoke's
  assigned node to prevent spoofing.

### Reference node-side implementation

- `hawky/src/node/runner.ts:94-125` — the node's handshake: on WS open,
  send `rpc("connect", { version, platform, role: "node", node: {...},
  token })`. `platform` is `process.platform` (e.g. "darwin"); for iOS we
  will use `"mobile"`.
- `hawky/src/node/runner.ts:131-169` — close handling. Code **4001 =
  evicted; do NOT reconnect** (stop the runner). Code 1008 = auth failure;
  call the reauth callback. Anything else = reconnect with exponential
  backoff.
- `hawky/src/node/runner.ts:259-299` — event dispatch: `tick`,
  `node.invoke.request`, `node.invoke.cancel`, `gateway.shutdown`.
- `hawky/src/node/runner.ts:305-380` — invoke handler. Parses
  `paramsJSON`, dispatches to the command table, then calls
  `sendInvokeResult(id, ok, payload, error?)` which RPCs
  `node.invoke.result` back with `payloadJSON`.
- `hawky/src/node/runner.ts:386-402` — RPC helper. Frame shape:
  `{ type: "req", id: "node-req-N", method, params }`. Gateway replies
  with `type: "res"`.
- `hawky/src/node/runner.ts:24-28` — reconnect constants: initial
  backoff 1000 ms, max 30 000 ms. Handshake timeout 5 000 ms. Tick
  timeout factor 2×.
- `hawky/src/node/runner.ts:493-522` — **token acquisition reuses
  `acquireDeviceToken` — the same flow the client uses**. Token is cached
  per-gateway on disk.

### Command registry

- `hawky/src/node/commands.ts:582-591` — commands are a `Record<string,
  (params, signal) => Promise<CommandResult>>`. The exported
  `SUPPORTED_COMMANDS` list is the advertised capability set sent with
  `node.hello`'s `commands` field.
- `hawky/src/node/commands.ts:461-508` — the reference `device.info`
  implementation returns `{ hostname, platform, arch, os, osVersion, cpu,
  cpuCores, memoryTotal, memoryFree, diskAvailable }`. **iOS cannot
  produce most of those** (no `os.cpus()`, no `df`). The Hawky MVP
  will return an iOS-appropriate payload from `UIDevice.current`:
  `{ model, systemName, systemVersion, name, batteryLevel, localizedModel
  }`. This is acceptable because the gateway forwards `payloadJSON`
  opaquely to the caller (`node-registry.ts:375-389`); the registry only
  validates the `ok`/`error` envelope.
- `hawky/src/node/commands.ts:597-607` — `dispatchCommand` throws for
  unknown commands; the runner catches and responds with
  `ok=false, error="Unknown node command: X"`. We mirror this behaviour.

### Error & timeout semantics

- Gateway-side invoke timeout: **30 s default**
  (`node-registry.ts:59`). The gateway sends `timeoutMs` in the payload
  so the node can enforce the same deadline; if the node exceeds it, the
  gateway resolves the pending promise with
  `{ ok: false, error: "Invoke timeout..." }` anyway (line 267-269).
- Node must reply with `ok: false, error: "..."` on any thrown error.
  Unhandled rejection ⇒ the gateway's timer eventually fires.
- Cancellation: `node.invoke.cancel` is best-effort; the node should
  abort the in-flight operation and still send a `node.invoke.result`
  with `ok=false, error="Cancelled"`.

## Sequence diagram

```
Hawky (node role)                       Hawky gateway
       │                                           │
       │  [already has JWT in Keychain from client role]
       │                                           │
       │  open wss://host/ws                       │
       │──────────────────────────────────────────►│
       │                                           │
       │  req { id, method: "connect",             │
       │        params: { version, platform,       │
       │                  token,                   │
       │                  role: "node",            │
       │                  node: { nodeId, name,    │
       │                          commands:        │
       │                          ["device.info"]  │
       │                        } } }              │
       │──────────────────────────────────────────►│
       │                                           │  deviceAuth.isValid(token) ✓
       │                                           │  nodeRegistry.register(...)
       │  res { id, ok: true,                      │
       │        payload: { connId, serverVersion,  │
       │                   methods } }             │
       │◄──────────────────────────────────────────│
       │                                           │
       │         ─── idle / waiting ───            │
       │                                           │
       │  event { event: "tick",                   │  every 30s
       │          payload: { ts, intervalMs } }    │
       │◄──────────────────────────────────────────│
       │                                           │
       │                                           │  client or agent
       │                                           │  calls gateway.invokeNode(
       │                                           │    nodeId, "device.info")
       │                                           │
       │  event { event: "node.invoke.request",    │
       │          payload: { id: "inv-uuid",       │
       │                     command: "device.info"│
       │                     paramsJSON: undefined,│
       │                     timeoutMs: 30000 } }  │
       │◄──────────────────────────────────────────│
       │                                           │
       │  [dispatch to DeviceInfoCommand]          │
       │  [collect UIDevice fields]                │
       │                                           │
       │  req { id: "node-req-N",                  │
       │        method: "node.invoke.result",      │
       │        params: { id: "inv-uuid",          │
       │                  nodeId,                  │
       │                  ok: true,                │
       │                  payloadJSON: "{\"model\":│
       │                     \"iPhone15,2\",...}"  │
       │                } }                        │
       │──────────────────────────────────────────►│
       │                                           │  registry resolves
       │                                           │  pending invoke
       │  res { id: "node-req-N", ok: true }       │
       │◄──────────────────────────────────────────│
       │                                           │
       │                (unknown command case)     │
       │  event { event: "node.invoke.request",    │
       │          payload: { command: "foo.bar" } }│
       │◄──────────────────────────────────────────│
       │  req { method: "node.invoke.result",      │
       │        params: { id, nodeId, ok: false,   │
       │                  error: "Unknown node     │
       │                          command: foo.bar"│
       │                } }                        │
       │──────────────────────────────────────────►│
```

## Implications for the iOS MVP

1. **Auth is free.** The Keychain-stored device JWT works for both roles.
   No new endpoint. If `role="node"` is ever rejected at the handshake
   with code 1008, the runner surfaces a clear error and the user
   re-authenticates via the existing Settings flow — same UX.
2. **Two WS connections when the node role is enabled.** The existing
   `ReconnectingTransport` + `URLSessionGatewayTransport` stack must be
   **duplicated in spirit, not reused verbatim**, because one physical
   socket is either client-bound (session, ChatClient) or node-bound
   (registry, command dispatch). We build a separate `NodeTransport`
   class. Frame shapes are identical so we reuse `RequestFrame` /
   `ResponseFrame` / `EventFrame` / `JSONValue`.
3. **`commands` advertised at hello MUST match the commands the runner
   actually handles.** Gateway gates invocations on the advertised list
   (`node-registry.ts:252-257`). MVP advertises `["device.info"]` only.
4. **Reply is a `req` frame.** Unlike a normal RPC, the node initiates
   `node.invoke.result` — it's a request FROM the node TO the gateway
   that expects a `res` ack. If we sent a `res` frame with a random id
   the gateway would silently drop it.
5. **`paramsJSON` and `payloadJSON` are strings.** Not nested objects.
   Easy-to-miss encoding boundary.
6. **Eviction (close 4001) must stop the reconnect loop.** Otherwise two
   devices sharing a nodeId enter an infinite eviction duel.
7. **`nodeId` persistence.** The reference uses a disk-persisted UUID
   (`config.ts:40-64`). On iOS we persist in UserDefaults under
   `nodeId`, generated with `UUID()` on first enable.

## Gotchas ranked

1. **Reply is a `req`, not a `res`.** `node.invoke.result` is a node→gateway
   RPC request. Easy to model wrong if you assume "response = res frame."
2. `paramsJSON` / `payloadJSON` are JSON-encoded strings nested inside
   the outer JSON frame. Double-encoding boundary.
3. Close code 4001 is terminal — never reconnect on it.
4. iOS `device.info` payload will intentionally diverge from the macOS
   reference; the gateway doesn't care, only the downstream caller does.
5. Tick cadence is gateway-driven (30 s); the node does not send its
   own heartbeat.

## Go/no-go

**Go.** Existing device-auth flow covers node auth. No iOS capability
gap. Implementing the MVP is straightforward.
