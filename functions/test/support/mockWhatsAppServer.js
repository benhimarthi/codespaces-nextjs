import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export function createMockWhatsAppServer({ token = "emulator-oidc-token" } = {}) {
  const messages = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const authorization = request.headers.authorization ?? "";
    const suppliedToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    const validToken = Buffer.byteLength(suppliedToken) === Buffer.byteLength(token) &&
      timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token));
    if (!validToken || request.method !== "POST" || request.url !== "/send") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const payload = JSON.parse(body.toString("utf8"));
    messages.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      success: true,
      data: {
        msgId: `mock-${messages.length}`,
        jid: `${payload.to}@s.whatsapp.net`,
        status: "in_progress",
      },
    }));
  });

  return {
    messages,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}/send`;
    },
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    },
  };
}
