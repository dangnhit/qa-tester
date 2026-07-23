import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

export type DemoServer = Readonly<{
  baseUrl: string;
  close(): Promise<void>;
}>;

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

/** Serves only the checked-in fixture and one intentionally broken local endpoint. */
export async function serveDemoFixture(): Promise<DemoServer> {
  const htmlPath = fileURLToPath(new URL("./index.html", import.meta.url));
  const html = await readFile(htmlPath, "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/api/demo-failure") {
      request.socket.destroy();
      return;
    }
    if (request.url !== "/" && request.url !== "/index.html") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("Demo server did not bind an ephemeral TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => close(server),
  };
}
