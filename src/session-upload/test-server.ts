import { createServer, type IncomingHttpHeaders } from "node:http";

/** Local server recording requests and answering with `status`. */
export async function server(status = 200) {
  const requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status).end(status === 200 ? "" : "denied by test");
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const { port } = srv.address() as { port: number };
  return { requests, endpoint: `http://127.0.0.1:${port}`, close: () => srv.close() };
}
