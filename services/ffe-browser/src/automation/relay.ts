import type { CDPSession, Page } from "playwright";

// Diffusion façon bureau à distance construite directement sur le Chrome DevTools Protocol
// (Playwright expose une session CDP brute) : plus simple qu'un serveur VNC dédié puisque
// Chromium parle déjà ce protocole nativement.
type Socket = {
  send(data: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
};

type InboundMessage =
  | { type: "mouse"; kind: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "key"; kind: "keyDown" | "keyUp" | "char"; key: string; code: string; text?: string }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number };

export async function attachScreencastRelay(page: Page, socket: Socket): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);

  const onFrame = (event: { data: string; sessionId: number }) => {
    socket.send(JSON.stringify({ type: "frame", data: event.data }));
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", onFrame);

  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 900 });

  socket.on("message", (raw) => {
    void handleInbound(cdp, raw).catch(() => undefined);
  });

  const stop = async () => {
    cdp.off("Page.screencastFrame", onFrame);
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  };
  socket.on("close", () => void stop());
  return stop;
}

async function handleInbound(cdp: CDPSession, raw: Buffer): Promise<void> {
  const message = JSON.parse(raw.toString()) as InboundMessage;
  if (message.type === "mouse") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: message.kind,
      x: message.x,
      y: message.y,
      button: message.button ?? "left",
      ...(message.kind === "mousePressed" ? { clickCount: 1 } : {})
    });
    return;
  }
  if (message.type === "wheel") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: message.x,
      y: message.y,
      deltaX: message.deltaX,
      deltaY: message.deltaY
    });
    return;
  }
  await cdp.send("Input.dispatchKeyEvent", {
    type: message.kind,
    key: message.key,
    code: message.code,
    ...(message.text !== undefined ? { text: message.text } : {})
  });
}
