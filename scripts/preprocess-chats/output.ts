import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LabeledSegment } from './label';
import type { DeduplicatedQA } from './dedup';

/**
 * Generate structured markdown files from labeled segments and deduplicated Q&A pairs.
 */
export function generateOutput(
  outputDir: string,
  segments: LabeledSegment[],
  qaPairs: DeduplicatedQA[],
): { conversationFiles: string[]; faqFiles: string[] } {
  const convoDir = join(outputDir, 'conversations');
  const faqDir = join(outputDir, 'faq');
  mkdirSync(convoDir, { recursive: true });
  mkdirSync(faqDir, { recursive: true });

  const conversationFiles: string[] = [];
  const faqFiles: string[] = [];

  // 1. Write conversation segment files
  for (const seg of segments) {
    const dateStr = formatDate(seg.segment.startTime);
    const patientSlug = slugify(seg.segment.participantNames[0] ?? 'unknown');
    const topicSlug = slugify(seg.summary.slice(0, 50));
    const filename = `${patientSlug}_${dateStr}_${topicSlug}.md`;

    const content = buildConversationMarkdown(seg);
    writeFileSync(join(convoDir, filename), content, 'utf-8');
    conversationFiles.push(`conversations/${filename}`);
  }

  // 2. Write deduplicated FAQ files
  // Group by treatment for organization
  const byTreatment = new Map<string, DeduplicatedQA[]>();
  for (const qa of qaPairs) {
    const group = byTreatment.get(qa.treatment) ?? [];
    group.push(qa);
    byTreatment.set(qa.treatment, group);
  }

  for (const [treatment, pairs] of byTreatment) {
    const filename = `${slugify(treatment)}-faq.md`;
    const content = buildFaqMarkdown(treatment, pairs);
    writeFileSync(join(faqDir, filename), content, 'utf-8');
    faqFiles.push(`faq/${filename}`);
  }

  return { conversationFiles, faqFiles };
}

function buildConversationMarkdown(seg: LabeledSegment): string {
  const dateStr = formatDate(seg.segment.startTime);
  const patient = seg.segment.participantNames[0] ?? 'Unknown';

  const frontmatter = [
    '---',
    'type: conversation',
    `date: ${dateStr}`,
    `patient: ${patient}`,
    `category: ${seg.category}`,
    `treatment: ${seg.treatment}`,
    `summary: ${seg.summary}`,
    `tone: ${seg.tone}`,
    '---',
  ].join('\n');

  const title = `# Conversation: ${seg.summary} (${dateStr})`;

  const messages = seg.segment.messages
    .map((msg) => {
      const time = msg.timestamp.toLocaleTimeString('tr-TR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `**${msg.sender}** (${time}): ${msg.text}`;
    })
    .join('\n');

  return `${frontmatter}\n\n${title}\n${messages}\n`;
}

function buildFaqMarkdown(
  treatment: string,
  pairs: DeduplicatedQA[],
): string {
  const lines: string[] = [
    '---',
    'type: faq',
    `treatment: ${treatment}`,
    `count: ${pairs.length}`,
    '---',
    '',
    `# FAQ: ${treatment}`,
    '',
  ];

  for (const qa of pairs) {
    lines.push(`## ${qa.question}`);
    lines.push('');
    lines.push(`**Category:** ${qa.category}`);
    lines.push(`**Sources:** ${qa.sources.join(', ')}`);
    lines.push('');
    lines.push(qa.answer);
    lines.push('');
  }

  return lines.join('\n');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
