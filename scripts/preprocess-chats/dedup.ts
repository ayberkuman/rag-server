import Anthropic from '@anthropic-ai/sdk';
import type { LabeledSegment } from './label';

export interface DeduplicatedQA {
  question: string;
  answer: string;
  category: string;
  treatment: string;
  sources: string[];
}

const DEDUP_PROMPT = `You are deduplicating Q&A pairs extracted from multiple patient conversations with a doctor.

Given a list of Q&A pairs, merge near-duplicates:
- Same question asked by different patients → keep the most complete/recent answer
- Similar questions about the same topic → merge into one canonical Q&A
- Keep the original language (Turkish) for questions and answers
- Preserve factual accuracy — do not add information not in the originals

Return a JSON array of deduplicated Q&A objects:
[
  {
    "question": "canonical question text",
    "answer": "best/most complete answer",
    "category": "category from original",
    "treatment": "treatment from original",
    "source_indices": [0, 3, 7]
  }
]

Respond ONLY with valid JSON array, no markdown fences or extra text.`;

/**
 * Deduplicate Q&A pairs across all labeled segments using LLM.
 * Groups by treatment first to reduce prompt size, then deduplicates within each group.
 */
export async function deduplicateQAPairs(
  client: Anthropic,
  segments: LabeledSegment[],
): Promise<DeduplicatedQA[]> {
  // Collect all Q&A pairs with source info
  const allPairs: Array<{
    question: string;
    answer: string;
    category: string;
    treatment: string;
    source: string;
  }> = [];

  for (const seg of segments) {
    const source = `${seg.segment.participantNames.join('-')}_${formatDate(seg.segment.startTime)}`;
    for (const qa of seg.qaPairs) {
      allPairs.push({
        question: qa.question,
        answer: qa.answer,
        category: seg.category,
        treatment: seg.treatment,
        source,
      });
    }
  }

  if (allPairs.length === 0) return [];

  // Group by treatment to keep prompt sizes manageable
  const byTreatment = new Map<string, typeof allPairs>();
  for (const pair of allPairs) {
    const group = byTreatment.get(pair.treatment) ?? [];
    group.push(pair);
    byTreatment.set(pair.treatment, group);
  }

  const results: DeduplicatedQA[] = [];

  for (const [treatment, pairs] of byTreatment) {
    if (pairs.length <= 1) {
      // No dedup needed for single pairs
      results.push({
        question: pairs[0].question,
        answer: pairs[0].answer,
        category: pairs[0].category,
        treatment: pairs[0].treatment,
        sources: [pairs[0].source],
      });
      continue;
    }

    const deduplicated = await dedupGroup(client, pairs);
    results.push(...deduplicated);
  }

  return results;
}

async function dedupGroup(
  client: Anthropic,
  pairs: Array<{
    question: string;
    answer: string;
    category: string;
    treatment: string;
    source: string;
  }>,
): Promise<DeduplicatedQA[]> {
  const pairsText = pairs
    .map(
      (p, i) =>
        `[${i}] Category: ${p.category} | Treatment: ${p.treatment}\nQ: ${p.question}\nA: ${p.answer}`,
    )
    .join('\n\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `${DEDUP_PROMPT}\n\nQ&A Pairs:\n${pairsText}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '[]';
    const parsed = JSON.parse(text) as Array<{
      question: string;
      answer: string;
      category: string;
      treatment: string;
      source_indices: number[];
    }>;

    return parsed.map((item) => ({
      question: item.question,
      answer: item.answer,
      category: item.category,
      treatment: item.treatment,
      sources: (item.source_indices ?? []).map((i) => pairs[i]?.source ?? 'unknown'),
    }));
  } catch (error) {
    console.error('Dedup failed:', error);
    // Fallback: return all pairs as-is
    return pairs.map((p) => ({
      question: p.question,
      answer: p.answer,
      category: p.category,
      treatment: p.treatment,
      sources: [p.source],
    }));
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
