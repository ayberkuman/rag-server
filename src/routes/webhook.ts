import { Hono } from 'hono';
import type { Env } from '../types/env';
import type { WhatsAppWebhookPayload } from '../types/whatsapp';
import type { ConversationMessage } from '../types/agent';
import { runAgent } from '../services/claude-agent';
import {
  sendWhatsAppMessage,
  getConversationHistory,
  appendBatchToConversation,
} from '../services/whatsapp';
import {
  isRateLimited,
  tryAcquireOrQueue,
  releaseAndDrain,
} from '../services/message-queue';

const FALLBACK_MESSAGE =
  'Şu anda sistemimizde bir sorun yaşıyoruz. En kısa sürede size dönüş yapılacaktır.';
const RATE_LIMIT_MESSAGE =
  'Çok fazla mesaj gönderiyorsunuz, lütfen biraz bekleyin.';
const MESSAGE_DEDUP_TTL = 60; // 1 minute TTL for dedup

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

  console.warn('Webhook verification failed');
  return c.text('Forbidden', 403);
});

// POST /webhook - Receive incoming messages
webhook.post('/', async (c) => {
  const payload = await c.req.json<WhatsAppWebhookPayload>();

  if (payload.object !== 'whatsapp_business_account') {
    return c.json({ error: 'Invalid payload' }, 400);
  }

  // Return 200 immediately, process via waitUntil
  c.executionCtx.waitUntil(processWebhook(payload, c.env));
  return c.text('OK', 200);
});

async function processWebhook(
  payload: WhatsAppWebhookPayload,
  env: Env['Bindings'],
): Promise<void> {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages' || !change.value.messages) continue;

      const { messages, contacts } = change.value;

      for (const message of messages) {
        if (message.type !== 'text' || !message.text) continue;

        // Message deduplication
        const dedupKey = `dedup:${message.id}`;
        const alreadySeen = await env.CONVERSATIONS_KV.get(dedupKey);
        if (alreadySeen) continue;
        await env.CONVERSATIONS_KV.put(dedupKey, '1', {
          expirationTtl: MESSAGE_DEDUP_TTL,
        });

        const phoneNumber = message.from;
        const customerName =
          contacts?.find((c) => c.wa_id === phoneNumber)?.profile.name ??
          'Patient';
        const messageText = message.text.body;

        console.log(
          `Message from ${customerName} (${phoneNumber}): ${messageText}`,
        );

        await handleIncomingMessage(
          env,
          phoneNumber,
          customerName,
          messageText,
        );
      }
    }
  }
}

async function handleIncomingMessage(
  env: Env['Bindings'],
  phoneNumber: string,
  customerName: string,
  messageText: string,
): Promise<void> {
  // Layer 1: Abuse detection
  const rateCheck = await isRateLimited(env.CONVERSATIONS_KV, phoneNumber);
  if (rateCheck.limited) {
    if (rateCheck.isFirstHit) {
      await sendWhatsAppMessage(
        env.WHATSAPP_ACCESS_TOKEN,
        env.WHATSAPP_PHONE_NUMBER_ID,
        phoneNumber,
        RATE_LIMIT_MESSAGE,
      );
    }
    return;
  }

  // Layer 2: Impatient patient queue
  const queueResult = await tryAcquireOrQueue(
    env.CONVERSATIONS_KV,
    phoneNumber,
    messageText,
  );

  if (queueResult.action === 'queued') {
    console.log(`Message queued for ${phoneNumber} (agent already processing)`);
    return;
  }

  // Process message (and any subsequent queued messages)
  await processWithAgent(env, phoneNumber, customerName, messageText);
}

async function processWithAgent(
  env: Env['Bindings'],
  phoneNumber: string,
  customerName: string,
  messageText: string,
): Promise<void> {
  try {
    // Store the incoming user message
    const userMessage: ConversationMessage = {
      role: 'user',
      content: messageText,
      timestamp: Date.now(),
      name: customerName,
    };
    await appendBatchToConversation(env.CONVERSATIONS_KV, phoneNumber, [
      userMessage,
    ]);

    // Get conversation history for context
    const history = await getConversationHistory(
      env.CONVERSATIONS_KV,
      phoneNumber,
    );

    // Run the agent (excludes the last message since we pass it separately)
    const historyWithoutCurrent = history.slice(0, -1);
    const agentResponse = await runAgent(
      env,
      historyWithoutCurrent,
      messageText,
      customerName,
      phoneNumber,
    );

    console.log(
      `Agent response for ${phoneNumber}: ${agentResponse.text.slice(0, 100)}... (${agentResponse.toolCalls} tool calls, ${agentResponse.usage.totalTokens} tokens)`,
    );

    // Send reply
    await sendWhatsAppMessage(
      env.WHATSAPP_ACCESS_TOKEN,
      env.WHATSAPP_PHONE_NUMBER_ID,
      phoneNumber,
      agentResponse.text,
    );

    // Store assistant message
    const assistantMessage: ConversationMessage = {
      role: 'assistant',
      content: agentResponse.text,
      timestamp: Date.now(),
    };
    await appendBatchToConversation(env.CONVERSATIONS_KV, phoneNumber, [
      assistantMessage,
    ]);

    // Check for queued messages from impatient patient
    const queuedMessages = await releaseAndDrain(
      env.CONVERSATIONS_KV,
      phoneNumber,
    );
    if (queuedMessages.length > 0) {
      console.log(
        `Processing ${queuedMessages.length} queued messages for ${phoneNumber}`,
      );
      // Combine all queued messages and process as a batch
      const combinedMessage = queuedMessages.join('\n');
      await processWithAgent(env, phoneNumber, customerName, combinedMessage);
    }
  } catch (error) {
    console.error(`Agent error for ${phoneNumber}:`, error);

    // Always respond — a 24/7 service cannot have silent failures
    try {
      await sendWhatsAppMessage(
        env.WHATSAPP_ACCESS_TOKEN,
        env.WHATSAPP_PHONE_NUMBER_ID,
        phoneNumber,
        FALLBACK_MESSAGE,
      );
    } catch (sendError) {
      console.error(`Failed to send fallback message to ${phoneNumber}:`, sendError);
    }

    // Release the processing lock even on error
    await releaseAndDrain(env.CONVERSATIONS_KV, phoneNumber);
  }
}

export { webhook };
