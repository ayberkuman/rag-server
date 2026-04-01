import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import type { Env } from './types/env';
import { webhook } from './routes/webhook';
import { test } from './routes/test';
import { documents } from './routes/documents';
import { admin } from './routes/admin';

const app = new Hono<Env>();

app.use('*', logger());
app.use('*', cors());

app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'WhatsApp Support Agent',
    endpoints: {
      '/webhook': 'WhatsApp webhook (GET verification, POST messages)',
      '/test': 'Agent testing (GET ?q= or POST with JSON body)',
      '/documents': 'Document management (GET list, POST upload, DELETE remove)',
      '/documents/sync': 'Trigger AI Search indexing (POST)',
      '/documents/jobs': 'List indexing jobs (GET)',
      '/admin/leads': 'Lead management (GET list, GET/:id, PATCH/:id)',
      '/admin/source-of-truth': 'Source of Truth (GET read, POST update)',
    },
  });
});

app.route('/webhook', webhook);
app.route('/test', test);
app.route('/documents', documents);
app.route('/admin', admin);

app.onError((err, c) => {
  console.error('Application error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;
