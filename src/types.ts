import type { WebSocket } from "ws";

export type MessageEnvelope = {
  to?: string; // target client id
  from?: string; // sender id (if known)
  type: string; // e.g., "countdown:start", "ping"
  payload?: unknown;
  ts?: number; // timestamp
};

export type ServerToClient = MessageEnvelope & {
  from: "server" | string;
};

export type ClientToServer = MessageEnvelope & {
  // Usually includes `to` when routing via server
};

export type ClientInfo = {
  id: string;
  socket: WebSocket;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type HttpJson = {
  status: "ok" | "error";
  message?: string;
  data?: JsonValue;
};
