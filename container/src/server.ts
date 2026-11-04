// STUB (Day-0, WP-A). Owner WP-C replaces this file. Serves /ping and an empty tools/list.
import http from 'node:http';

export function startServer(opts: { port?: number } = {}): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        let id: unknown = null;
        let method = '';
        try {
          const msg = JSON.parse(body) as { id?: unknown; method?: string };
          id = msg.id ?? null;
          method = msg.method ?? '';
        } catch {
          /* fall through */
        }
        const result = method === 'tools/list' ? { tools: [] } : {};
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(opts.port ?? 8000, '0.0.0.0');
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) startServer();
