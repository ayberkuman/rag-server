import { Hono } from 'hono';
import type { Env } from '../types/env';
import { runAgent } from '../services/claude-agent';

const test = new Hono<Env>();

// GET /test - Test the agent with a query parameter
test.get('/', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({
      message: 'WhatsApp Support Agent Test Endpoint',
      usage: 'GET /test?q=your question here',
      example: 'GET /test?q=Botoks fiyatı ne kadar?',
    });
  }

  const response = await runAgent(
    c.env,
    [], // no conversation history
    query,
    'Test User',
    '+905551234567',
  );

  return c.json({
    query,
    response: response.text,
    toolCalls: response.toolCalls,
    usage: response.usage,
  });
});

// POST /test - Test with JSON body and optional conversation history
test.post('/', async (c) => {
  const body = await c.req.json<{
    message: string;
    name?: string;
    phone?: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  }>();

  if (!body.message) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const history = (body.history ?? []).map((msg) => ({
    ...msg,
    timestamp: Date.now(),
  }));

  const response = await runAgent(
    c.env,
    history,
    body.message,
    body.name ?? 'Test User',
    body.phone ?? '+905551234567',
  );

  return c.json({
    customer: body.name ?? 'Test User',
    question: body.message,
    answer: response.text,
    toolCalls: response.toolCalls,
    usage: response.usage,
  });
});

export { test };
