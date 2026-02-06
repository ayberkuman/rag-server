import type { Env } from '../types/env';

export interface CustomerSupportResponse {
  answer: string;
  success: boolean;
  error?: string;
}

export interface CustomerSupportStreamResponse {
  stream: ReadableStream;
  success: boolean;
  error?: string;
}

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_SYSTEM_PROMPT = `You are a helpful customer support assistant.
Your role is to:
- Answer customer questions accurately and politely
- If you don't know the answer, say so honestly
- Keep responses concise but complete
- Be professional and empathetic`;

export async function queryCustomerSupport(
  ai: Env['Bindings']['AI'],
  instanceId: string,
  userQuery: string
): Promise<CustomerSupportResponse> {
  try {
    const result = await ai.autorag(instanceId).aiSearch({
      query: userQuery,
      model: DEFAULT_MODEL,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
    });

    return {
      answer: result.response,
      success: true,
    };
  } catch (error) {
    console.error('AI Search error:', error);
    return {
      answer: 'I apologize, but I am unable to process your request at this time. Please try again later.',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Transforms SSE stream from Cloudflare AI Search into plain text.
 * Input format: data: {"response":"Hello","p":"..."}\n\n
 * Output format: Hello (plain text)
 */
function createSSETextTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete SSE messages (ending with double newline)
      const messages = buffer.split('\n\n');
      // Keep the last incomplete message in the buffer
      buffer = messages.pop() || '';

      for (const message of messages) {
        const dataLine = message.trim();
        if (!dataLine.startsWith('data: ')) continue;

        const jsonStr = dataLine.slice(6); // Remove "data: " prefix
        if (jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr) as { response?: string; };
          if (parsed.response) {
            controller.enqueue(encoder.encode(parsed.response));
          }
        } catch {
          // Skip malformed JSON
        }
      }
    },
    flush(controller) {
      // Process any remaining data in the buffer
      if (buffer.trim().startsWith('data: ')) {
        const jsonStr = buffer.trim().slice(6);
        if (jsonStr !== '[DONE]') {
          try {
            const parsed = JSON.parse(jsonStr) as { response?: string; };
            if (parsed.response) {
              controller.enqueue(encoder.encode(parsed.response));
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    },
  });
}

export async function queryCustomerSupportStream(
  ai: Env['Bindings']['AI'],
  instanceId: string,
  userQuery: string
): Promise<CustomerSupportStreamResponse> {
  try {
    // When stream: true, the return type is Response (not AutoRagAiSearchResponse)
    const response = await ai.autorag(instanceId).aiSearch({
      query: userQuery,
      model: DEFAULT_MODEL,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      stream: true,
    });
    console.log(await response.json());
    if (!response.body) {
      throw new Error('No response body');
    }

    // Transform the SSE stream to plain text
    const transformedStream = response.body.pipeThrough(createSSETextTransformer());

    return {
      stream: transformedStream,
      success: true,
    };
  } catch (error) {
    console.error('AI Search stream error:', error);
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('I apologize, but I am unable to process your request at this time.'));
          controller.close();
        },
      }),
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
