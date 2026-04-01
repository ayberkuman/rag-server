import type { ConversationMessage } from '../types/agent';

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0';
const MAX_CONVERSATION_MESSAGES = 50;
const WHATSAPP_CHAR_LIMIT = 4096;

export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text, WHATSAPP_CHAR_LIMIT);

  for (const chunk of chunks) {
    const response = await fetch(
      `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: chunk },
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('WhatsApp send failed:', error);
      throw new Error(`WhatsApp API error: ${response.status}`);
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find the last sentence boundary within the limit
    let splitIndex = remaining.lastIndexOf('. ', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex + 1).trim());
    remaining = remaining.slice(splitIndex + 1).trim();
  }

  return chunks;
}

export async function getConversationHistory(
  kv: KVNamespace,
  phoneNumber: string,
): Promise<ConversationMessage[]> {
  const key = `conv:${phoneNumber}`;
  const data = await kv.get<ConversationMessage[]>(key, 'json');
  return data ?? [];
}

export async function appendToConversation(
  kv: KVNamespace,
  phoneNumber: string,
  message: ConversationMessage,
): Promise<void> {
  const history = await getConversationHistory(kv, phoneNumber);
  history.push(message);

  // Rolling window: keep only the last N messages
  const trimmed = history.length > MAX_CONVERSATION_MESSAGES
    ? history.slice(history.length - MAX_CONVERSATION_MESSAGES)
    : history;

  await kv.put(`conv:${phoneNumber}`, JSON.stringify(trimmed));
}

export async function appendBatchToConversation(
  kv: KVNamespace,
  phoneNumber: string,
  messages: ConversationMessage[],
): Promise<void> {
  const history = await getConversationHistory(kv, phoneNumber);
  history.push(...messages);

  const trimmed = history.length > MAX_CONVERSATION_MESSAGES
    ? history.slice(history.length - MAX_CONVERSATION_MESSAGES)
    : history;

  await kv.put(`conv:${phoneNumber}`, JSON.stringify(trimmed));
}
