// Local UI preview with synthetic data; never reads account files or history.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../src/renderer");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (name !== path.basename(name) || !types[path.extname(name)]) { response.writeHead(404).end(); return; }
  fs.readFile(path.join(root, name), (error, content) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": `${types[path.extname(name)]}; charset=utf-8`, "Cache-Control": "no-store" });
    response.end(content);
  });
}).listen(4173, "127.0.0.1", () => console.log("Preview: http://127.0.0.1:4173/?preview=1"));
