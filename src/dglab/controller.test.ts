import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { configSchema } from "../config/schema.ts";
import { EventBus } from "../events/bus.ts";
import { DglabController } from "./controller.ts";

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (server) {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function createMockSocketServer(onConnection: (socket: WebSocket) => void): Promise<string> {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing websocket server port");
  return `ws://127.0.0.1:${address.port}`;
}

describe("DglabController", () => {
  it("connects, receives clientId, tracks binding, and sends commands", async () => {
    const received: unknown[] = [];
    const socketUrl = await createMockSocketServer((socket) => {
      socket.send(JSON.stringify({ type: "bind", clientId: "client-1", targetId: "", message: "targetId" }));
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
      setTimeout(() => {
        socket.send(JSON.stringify({ type: "bind", clientId: "client-1", targetId: "app-1", message: "200" }));
      }, 10);
    });

    const config = configSchema.parse({
      dglab: {
        enabled: true,
        socket_url: socketUrl,
        qr_host: "127.0.0.1"
      }
    });
    const bus = new EventBus(20);
    const controller = new DglabController(config.dglab, bus);

    await controller.connect();
    await controller.waitForClientId();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(controller.getStatus()).toMatchObject({
      connected: true,
      bound: true,
      clientId: "client-1",
      targetId: "app-1"
    });
    expect(controller.getStatus().qrLink).toContain("#DGLAB-SOCKET#");
    // qr_port keeps its default here on purpose: the phone dials qr_host/qr_port,
    // not socket_url, so moving only socket_url leaves the QR pointing at 9999.
    expect(controller.getStatus().qrSocketUrl).toBe("ws://127.0.0.1:9999");

    await controller.clear("A");
    await controller.setStrength("B", 12);
    await waitUntil(() => received.length === 2);

    expect(received).toEqual([
      { type: 4, clientId: "client-1", targetId: "app-1", message: "clear-1" },
      { type: 3, clientId: "client-1", targetId: "app-1", channel: 2, strength: 12, message: "set channel" }
    ]);
    expect(bus.getRecent().map((event) => event.type)).toContain("dglab.bound");

    await controller.disconnect();
  });

  it("reports the address the phone dials, not the loopback socket the plugin uses", () => {
    const config = configSchema.parse({
      dglab: {
        enabled: true,
        socket_url: "ws://127.0.0.1:9999",
        qr_host: "192.168.7.7",
        qr_port: 9123
      }
    });
    const controller = new DglabController(config.dglab, new EventBus(20));

    // The panel prints this string, so a loopback address here is what makes a
    // blocked port look like a working link.
    expect(controller.getStatus().qrSocketUrl).toBe("ws://192.168.7.7:9123");
    expect(controller.getStatus().socketUrl).toBe("ws://127.0.0.1:9999");
  });

  it("closes a socket that is still handshaking without throwing", async () => {
    // A TCP listener that never answers the WebSocket upgrade keeps the client
    // in CONNECTING, which is where ws reports the abort as an error event.
    const accepted: Socket[] = [];
    const silent = createServer((socket) => {
      socket.on("error", () => undefined);
      accepted.push(socket);
    });
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    const address = silent.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const config = configSchema.parse({
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${address.port}`, qr_host: "127.0.0.1" }
    });
    const controller = new DglabController(config.dglab, new EventBus(20));

    try {
      void controller.connect().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(controller.disconnect()).resolves.toBeUndefined();
    } finally {
      for (const socket of accepted) {
        socket.destroy();
      }
      silent.close();
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
