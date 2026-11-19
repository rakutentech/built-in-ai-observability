// A static file server with no dependencies, so the example's files reach the browser exactly as
// they are on disk. Any other static server works too (python3 -m http.server, …).
//
//   node serve.js [port]      (default 8765; localhost counts as a secure context)

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.argv[2] ?? 8765);
const TYPES = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(
    new URL(req.url ?? "/", "http://localhost").pathname
  );
  const file = join(ROOT, normalize(path === "/" ? "/index.html" : path));
  // Serve files below this folder only.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) {
      throw new Error("not a file");
    }
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`MLflow eval example: http://localhost:${PORT}`);
});
