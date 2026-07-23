import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

export async function serveBrowserFixture(path: string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const html = await readFile(path, "utf8");
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server address unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
