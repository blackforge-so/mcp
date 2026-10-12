// A fake API + realtime relay on one local HTTP server, for tests. No
// dependencies: the WebSocket side is a minimal RFC 6455 server (handshake,
// masked client text frames in, unmasked text frames out, close), which is
// all the protocol this client uses.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

export interface FakeWsConn {
  headers: IncomingMessage["headers"];
  url: string;
  send(obj: unknown): void;
  close(): void;
  received: unknown[];
}

export interface FakeRealtime {
  url: string;
  requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"]; body: unknown }>;
  wsConns: FakeWsConn[];
  close(): Promise<void>;
}

export type HttpHandler = (req: {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage["headers"];
}) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

export type WsHandler = (conn: FakeWsConn, msg: Record<string, unknown> | null) => void;

function encodeText(s: string): Buffer {
  const payload = Buffer.from(s);
  const n = payload.length;
  let header: Buffer;
  if (n < 126) header = Buffer.from([0x81, n]);
  else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parse as many complete client frames as the buffer holds. */
function decodeFrames(buf: Buffer): { frames: Array<{ op: number; data: Buffer }>; rest: Buffer } {
  const frames: Array<{ op: number; data: Buffer }> = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ op, data });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export async function startFakeRealtime(http: HttpHandler, ws?: WsHandler, opts?: { rejectWs?: number }): Promise<FakeRealtime> {
  const requests: FakeRealtime["requests"] = [];
  const wsConns: FakeWsConn[] = [];
  const sockets = new Set<Duplex>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const raw = Buffer.concat(chunks).toString();
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method: req.method ?? "GET", path: u.pathname + u.search, headers: req.headers, body });
      const out = http({ method: req.method ?? "GET", path: u.pathname, query: u.searchParams, body, headers: req.headers }) ?? {
        status: 404,
        body: { error: { code: "not_found" } },
      };
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    if (opts?.rejectWs) {
      socket.end(`HTTP/1.1 ${opts.rejectWs} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn: FakeWsConn = {
      headers: req.headers,
      url: req.url ?? "",
      received: [],
      send: (obj) => {
        if (!socket.destroyed) socket.write(encodeText(JSON.stringify(obj)));
      },
      close: () => {
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
          socket.end();
        }
      },
    };
    wsConns.push(conn);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { frames, rest } = decodeFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const f of frames) {
        if (f.op === 0x8) {
          if (!socket.destroyed) {
            socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
            socket.end();
          }
          return;
        }
        if (f.op === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data]));
          continue;
        }
        if (f.op !== 0x1) continue;
        let msg: Record<string, unknown> | null = null;
        try {
          msg = JSON.parse(f.data.toString());
        } catch {
          msg = null;
        }
        conn.received.push(msg);
        ws?.(conn, msg);
      }
    });
    socket.on("error", () => {});
    ws?.(conn, null); // connection opened
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    wsConns,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
