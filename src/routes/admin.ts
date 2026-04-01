import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { Lead } from '../types/agent';
import { getLead, listLeads, updateLeadStatus } from '../services/lead-capture';

const admin = new Hono<Env>();

// Auth middleware — all admin routes require ADMIN_API_KEY
admin.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token || token !== c.env.ADMIN_API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

// GET /admin/leads — list leads with optional status filter
admin.get('/leads', async (c) => {
  const status = c.req.query('status') as Lead['status'] | undefined;
  const leads = await listLeads(c.env.LEADS_KV, status);
  return c.json({ leads, count: leads.length });
});

// GET /admin/leads/:id — get a single lead
admin.get('/leads/:id', async (c) => {
  const lead = await getLead(c.env.LEADS_KV, c.req.param('id'));
  if (!lead) return c.json({ error: 'Lead not found' }, 404);
  return c.json({ lead });
});

// PATCH /admin/leads/:id — update lead status
admin.patch('/leads/:id', async (c) => {
  const body = await c.req.json<{ status: Lead['status'] }>();
  const validStatuses: Lead['status'][] = [
    'new',
    'contacted',
    'converted',
    'dismissed',
  ];

  if (!validStatuses.includes(body.status)) {
    return c.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
      400,
    );
  }

  const updated = await updateLeadStatus(
    c.env.LEADS_KV,
    c.req.param('id'),
    body.status,
  );

  if (!updated) return c.json({ error: 'Lead not found' }, 404);
  return c.json({ lead: updated });
});

// GET /admin/source-of-truth — read the SoT document
admin.get('/source-of-truth', async (c) => {
  const obj = await c.env.DOCUMENTS_BUCKET.get('source-of-truth.md');
  if (!obj) {
    return c.json({ content: null, message: 'No source of truth document found' });
  }
  const content = await obj.text();
  return c.json({ content });
});

// POST /admin/source-of-truth — update the SoT document
admin.post('/source-of-truth', async (c) => {
  const body = await c.req.json<{ content: string }>();

  if (!body.content) {
    return c.json({ error: 'Content is required' }, 400);
  }

  await c.env.DOCUMENTS_BUCKET.put('source-of-truth.md', body.content, {
    httpMetadata: { contentType: 'text/markdown' },
  });

  return c.json({ message: 'Source of truth updated', size: body.content.length });
});

export { admin };
