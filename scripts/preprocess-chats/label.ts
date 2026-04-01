import Anthropic from '@anthropic-ai/sdk';
import type { Segment } from './segment';

export interface LabeledSegment {
  segment: Segment;
  category: string;
  treatment: string;
  summary: string;
  tone: string;
  qaPairs: Array<{ question: string; answer: string }>;
}

const LABEL_PROMPT = `You are analyzing a WhatsApp conversation segment between a doctor and a patient.
Analyze the conversation and return a JSON object with these fields:

- "category": one of: pricing_inquiry, appointment_booking, treatment_info, follow_up, complaint, consultation, greeting, general_inquiry
- "treatment": the specific treatment/procedure discussed (e.g., "botox", "rhinoplasty", "filler"), or "general" if not treatment-specific
- "summary": a one-line English summary of the conversation topic
- "tone": describe the doctor's tone in 2-3 words (e.g., "warm, informative", "professional, empathetic")
- "qa_pairs": array of {question, answer} pairs extracted from the conversation. The question should be what the patient asked (generalized), and the answer should be the doctor's response (factual content only). Keep in original language (Turkish). Return empty array if no clear Q&A pairs.

Respond ONLY with valid JSON, no markdown fences or extra text.`;

export async function labelSegments(
  client: Anthropic,
  segments: Segment[],
  concurrency = 5,
): Promise<LabeledSegment[]> {
  const results: LabeledSegment[] = [];

  // Process in batches for rate limiting
  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((segment) => labelSingleSegment(client, segment)),
    );
    results.push(...batchResults.filter((r): r is LabeledSegment => r !== null));
  }

  return results;
}

async function labelSingleSegment(
  client: Anthropic,
  segment: Segment,
): Promise<LabeledSegment | null> {
  const conversationText = segment.messages
    .map((msg) => `${msg.sender} (${formatTime(msg.timestamp)}): ${msg.text}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `${LABEL_PROMPT}\n\nConversation:\n${conversationText}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text);

    return {
      segment,
      category: parsed.category ?? 'general_inquiry',
      treatment: parsed.treatment ?? 'general',
      summary: parsed.summary ?? '',
      tone: parsed.tone ?? '',
      qaPairs: (parsed.qa_pairs ?? []).map(
        (pair: { question: string; answer: string }) => ({
          question: pair.question,
          answer: pair.answer,
        }),
      ),
    };
  } catch (error) {
    console.error('Labeling failed for segment:', error);
    return null;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
