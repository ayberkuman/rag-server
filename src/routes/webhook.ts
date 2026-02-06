import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { WhatsAppWebhookPayload } from '../types/whatsapp';
import { queryCustomerSupport } from '../services/ai-search';

const webhook = new Hono<Env>();

// GET /webhook - Webhook verification
webhook.get('/', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token === c.env.VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return c.text(challenge || '', 200);
  }

  console.warn('Webhook verification failed', { mode, tokenMatch: token === c.env.VERIFY_TOKEN });
  return c.text('Forbidden', 403);
});

// POST /webhook - Receive incoming messages
webhook.post('/', async (c) => {
  try {
    const payload = await c.req.json<WhatsAppWebhookPayload>();

    if (payload.object !== 'whatsapp_business_account') {
      return c.json({ error: 'Invalid payload' }, 400);
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const { messages, contacts } = change.value;

        for (const message of messages) {
          if (message.type !== 'text' || !message.text) continue;

          const customerName = contacts.find((contact) => contact.wa_id === message.from)?.profile.name || 'Customer';
          const userQuery = message.text.body;

          console.log(`Received message from ${customerName} (${message.from}): ${userQuery}`);

          const aiResponse = await queryCustomerSupport(c.env.AI, c.env.AI_SEARCH_INSTANCE_ID, userQuery);

          console.log(`AI Response for ${message.from}:`, aiResponse.answer);

          // TODO: When WhatsApp API keys are available, implement sendWhatsAppMessage()
        }
      }
    }

    return c.text('OK', 200);
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export { webhook };
