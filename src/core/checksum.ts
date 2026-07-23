import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
