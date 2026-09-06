import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve("dist");
http
  .createServer(async (req, res) => {
    let p = new URL(req.url, "http://localhost").pathname;
    if (p === "/") p = "/index.html";
    else if (/^\/blog\/?$/.test(p)) p = "/blog/index.html";
    else if (/^\/admin\/blog\/?$/.test(p)) p = "/admin/blog/index.html";
    else if (/^\/blog\/[a-z0-9-]+\/?$/.test(p)) p = "/blog/post.html";
    const file = path.resolve(root, "." + p);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.setHeader(
        "Content-Type",
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          path.extname(file)
        ] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(4173, "127.0.0.1", () =>
    console.log("Preview: http://127.0.0.1:4173"),
  );
