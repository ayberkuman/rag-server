import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import { webhook } from './routes/webhook';
import { test } from './routes/test';
import { documents } from './routes/documents';

const app = new Hono<Env>();

app.use('*', logger());
app.use('*', cors());

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'Customer Support Agent',
    endpoints: {
      '/webhook': 'WhatsApp webhook (GET for verification, POST for messages)',
      '/test': 'Local testing endpoint (GET with ?q= or POST with JSON body)',
      '/test/stream': 'Streaming test endpoint (GET with ?q=)',
      '/documents': 'Document management (GET list, POST upload, DELETE remove)',
      '/documents/sync': 'Trigger AI Search indexing (POST)',
      '/documents/jobs': 'List indexing jobs (GET)',
      '/documents/jobs/:id': 'Get job details (GET)',
      '/documents/jobs/:id/logs': 'Get job logs (GET)',
    },
  });
});

app.route('/webhook', webhook);
app.route('/test', test);
app.route('/documents', documents);

app.onError((err, c) => {
  console.error('Application error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;
