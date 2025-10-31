/**
 * ZEvent 2025 - Minimal WebSocket + HTTP server (TypeScript)
 *
 * Features:
 * - WebSocket server on a configurable port (PORT env or 4000)
 * - Client registry by id from URL query param: ws://host:PORT/?id=<streamerId>
 * - Message routing: server can forward JSON envelopes to a specific client
 * - HTTP routes for debugging:
 *   - GET  /list-clients           -> returns array of connected ids
 *   - GET  /ping?id=<id>           -> sends a ping message to a client
 *   - GET  /broadcast              -> broadcasts a test message
 *   - POST /broadcast              -> broadcasts posted JSON payload as a message
 *   - GET  /health                 -> health check
 *
 * Notes
 * - Implement your own message handler inside `onClientMessage` and the routing/auth you need.
 * - Add authentication/authorization and any signature/secret validation here.
 * - Integrate with OBS docks and localStorage in your front-end; this server simply routes messages.
 */

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { parse as parseUrl } from "url";
import { ClientToServer, ServerToClient, HttpJson } from "./types";

const PORT = Number(process.env.PORT || 4000);

// Registry of connected clients: id -> WebSocket
const clients = new Map<string, WebSocket>();

// Utility: send JSON response with CORS
function sendJson(res: http.ServerResponse, body: HttpJson, statusCode = 200) {
  const json = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(json);
}

function notFound(res: http.ServerResponse) {
  sendJson(res, { status: "error", message: "Not Found" }, 404);
}

// Broadcast helper
function broadcast(message: Omit<ServerToClient, "from"> & { from?: string }) {
  const envelope: ServerToClient = {
    from: message.from ?? "server",
    to: message.to,
    type: message.type,
    payload: message.payload,
    ts: Date.now(),
  };
  const data = JSON.stringify(envelope);
  let count = 0;
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      count++;
    }
  }
  return count;
}

// Send to specific client by id; returns true if delivered
function sendTo(id: string, message: Omit<ServerToClient, "from"> & { from?: string }) {
  const ws = clients.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const envelope: ServerToClient = {
    from: message.from ?? "server",
    to: id,
    type: message.type,
    payload: message.payload,
    ts: Date.now(),
  };
  ws.send(JSON.stringify(envelope));
  return true;
}

// HTTP server
const server = http.createServer((req, res) => {
  if (!req.url) return notFound(res);

  // Preflight for CORS
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }

  const { pathname, query } = parseUrl(req.url, true);

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, { status: "ok", data: { uptime: process.uptime(), clients: clients.size } });
  }

  if (req.method === "GET" && pathname === "/list-clients") {
    return sendJson(res, { status: "ok", data: Array.from(clients.keys()) });
  }

  if (req.method === "GET" && pathname === "/broadcast") {
    const count = broadcast({ type: "server:broadcast:test", payload: { note: "Hello from server" } });
    return sendJson(res, { status: "ok", message: `Broadcast sent to ${count} client(s)` });
  }

  if (req.method === "POST" && pathname === "/broadcast") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        const type = typeof parsed.type === "string" ? parsed.type : "server:broadcast";
        const payload = parsed.payload ?? parsed;
        const count = broadcast({ type, payload });
        sendJson(res, { status: "ok", message: `Broadcast sent to ${count} client(s)` });
      } catch (err) {
        sendJson(res, { status: "error", message: (err as Error).message }, 400);
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/ping") {
    const id = typeof query?.id === "string" ? query.id : undefined;
    if (!id) return sendJson(res, { status: "error", message: "Missing id" }, 400);
    const ok = sendTo(id, { type: "server:ping", payload: { ts: Date.now() } });
    if (!ok) return sendJson(res, { status: "error", message: `Client '${id}' not connected` }, 404);
    return sendJson(res, { status: "ok", message: `Ping sent to '${id}'` });
  }

  // GET /tiktok/follow -> runs the scraper for username " freekadelle_ " and returns follower count
  if (req.method === "GET" && pathname === "/tiktok/follow") {
    const username = " freekadelle_ ".trim();

    // Execute the scraper (imported from ../tiktok_scrapper.js)
    const timeoutMs = 120000; // 120s timeout by default (scraping can be slow)
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sendJson(res, { status: "error", message: "Scraping timed out" }, 504);
    }, timeoutMs);

    (async () => {
      try {
        // Dynamically require the JS scraper to avoid TS type issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const TikTok = require("../tiktok_scrapper");
        const result: any = await (TikTok as any).scrapeTikTokStats(username);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const followers = result?.profile?.followers ?? null;
        return sendJson(res, { status: "ok", data: { username, followers } });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = (err as Error)?.message || String(err);
        return sendJson(res, { status: "error", message }, 500);
      }
    })();
    return;
  }

  // GET /tiktok/don/1, /tiktok/don/2, /tiktok/don/5 -> broadcast donation event to all websocket clients
  if (req.method === "GET" && (pathname === "/tiktok/don/1" || pathname === "/tiktok/don/2" || pathname === "/tiktok/don/5")) {
    const amount = Number(pathname!.split("/").pop());
    const delivered = broadcast({ type: "tiktok:don", payload: { amount, via: "http" } });
    return sendJson(res, { status: "ok", message: `tiktok:don (${amount}) to ${delivered} client(s)`, data: { amount, delivered } });
  }

  return notFound(res);
});

// WebSocket server sharing the same HTTP server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const { query } = parseUrl(req.url || "", true);
  const id = typeof query?.id === "string" ? query.id.trim().toLowerCase() : undefined;

  if (!id) {
    ws.send(JSON.stringify({ from: "server", type: "error", payload: { message: "Missing id in query string" }, ts: Date.now() }));
    ws.close(1008, "Missing id"); // Policy Violation
    return;
  }

  // Handle duplicate connections (replace the old one)
  const existing = clients.get(id);
  if (existing && existing !== ws) {
    console.log(`[ws] replacing existing client: ${id}`);
    try { existing.close(1000, "Replaced by new connection"); } catch {}
  }
  clients.set(id, ws);

  console.log(`[ws] client connected: ${id} (clients=${clients.size})`);

  // Heartbeat (optional): track if client responds to ping
  // We'll mark an isAlive flag; ws library handles pong event
  (ws as any).isAlive = true;
  ws.on("pong", () => ((ws as any).isAlive = true));

  // Notify others or just log
  // TODO: Add auth and permission checks if broadcasting presence events

  ws.on("message", (data: RawData) => onClientMessage(id, ws, data));

  ws.on("close", () => {
    const current = clients.get(id);
    if (current === ws) {
      clients.delete(id);
      console.log(`[ws] client disconnected: ${id} (clients=${clients.size})`);
    }
  });

  ws.on("error", (err: Error) => {
    console.warn(`[ws] error from ${id}:`, err.message);
  });
});

// Heartbeat interval to terminate dead connections
const interval = setInterval(() => {
  for (const [id, ws] of clients) {
    const alive = (ws as any).isAlive;
    if (alive === false) {
      try { ws.terminate(); } catch {}
      clients.delete(id);
      console.log(`[ws] terminated dead connection: ${id}`);
      continue;
    }
    (ws as any).isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

function onClientMessage(id: string, ws: WebSocket, data: RawData) {
  const text = typeof data === "string" ? data : data.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    ws.send(JSON.stringify({ from: "server", type: "error", payload: { message: "Invalid JSON" }, ts: Date.now() }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    ws.send(JSON.stringify({ from: "server", type: "error", payload: { message: "Invalid message format" }, ts: Date.now() }));
    return;
  }

  const msg = parsed as ClientToServer;

  (msg as any).from = id;
  if (!(typeof (msg as any).type === "string")) {
    ws.send(JSON.stringify({ from: "server", type: "error", payload: { message: "Missing 'type'" }, ts: Date.now() }));
    return;
  }

  // Basic routing: if `to` present, forward to that client
  if ((msg as any).to) {
    const delivered = sendTo((msg as any).to as string, { type: (msg as any).type as string, payload: (msg as any).payload, from: id });
    if (!delivered) {
      ws.send(JSON.stringify({ from: "server", type: "error", payload: { message: `Target '${(msg as any).to}' not connected` }, ts: Date.now() }));
    } else {
      // Optional ack
      ws.send(JSON.stringify({ from: "server", type: "ack", payload: { to: (msg as any).to, type: (msg as any).type }, ts: Date.now() }));
    }
    return;
  }

  // TODO: Place your custom message handling here when not routing to a specific client.
  // Example: handle commands like "countdown:start" globally, or store values for OBS docks, etc.

  // For now, echo back
  ws.send(JSON.stringify({ from: "server", type: "echo", payload: msg, ts: Date.now() }));
}

server.listen(PORT, () => {
  console.log(`[http] listening on http://localhost:${PORT}`);
  console.log(`[ws]   listening on ws://localhost:${PORT} (connect with ?id=<your-id>)`);
});
