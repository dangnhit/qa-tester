import { access, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "shared", "templates");
const destination = join(root, "dist", "shared", "templates");

async function copyAssets(): Promise<void> {
  try {
    await access(source);
  } catch {
    throw new Error(`copy-assets: source directory not found: ${source}`);
  }
  await cp(source, destination, { recursive: true });
}

await copyAssets();
