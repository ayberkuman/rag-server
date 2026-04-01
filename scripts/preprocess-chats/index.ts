#!/usr/bin/env npx tsx

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseWhatsAppExport } from './parse';
import { segmentConversation } from './segment';
import { labelSegments, type LabeledSegment } from './label';
import { deduplicateQAPairs } from './dedup';
import { generateOutput } from './output';

interface Progress {
  completedFiles: string[];
  labeledSegments: LabeledSegment[];
}

const PROGRESS_FILE = 'progress.json';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: npx tsx scripts/preprocess-chats/index.ts <input-dir> <output-dir>',
    );
    process.exit(1);
  }

  const inputDir = resolve(args[0]);
  const outputDir = resolve(args[1]);

  if (!existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  // Load API key from environment
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      'ANTHROPIC_API_KEY environment variable is required.\nSet it in .env or export it.',
    );
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Load progress for crash recovery
  const progressPath = join(outputDir, PROGRESS_FILE);
  const progress: Progress = existsSync(progressPath)
    ? JSON.parse(readFileSync(progressPath, 'utf-8'))
    : { completedFiles: [], labeledSegments: [] };

  // Find all .txt files
  const files = readdirSync(inputDir).filter((f) => f.endsWith('.txt'));
  const pendingFiles = files.filter(
    (f) => !progress.completedFiles.includes(f),
  );

  console.log(
    `Found ${files.length} files, ${pendingFiles.length} pending (${progress.completedFiles.length} already processed)`,
  );

  // Phase 1: Parse and segment
  console.log('\n--- Phase 1: Parse & Segment ---');
  const allSegments: LabeledSegment[] = [...progress.labeledSegments];

  for (const file of pendingFiles) {
    const filePath = join(inputDir, file);
    const content = readFileSync(filePath, 'utf-8');

    console.log(`Processing: ${file}`);

    // Parse
    const chat = parseWhatsAppExport(content, file);
    console.log(`  ${chat.messages.length} messages, patient: ${chat.patientName}`);

    // Segment
    const segments = segmentConversation(chat.messages);
    console.log(`  ${segments.length} segments`);

    if (segments.length === 0) {
      progress.completedFiles.push(file);
      saveProgress(progressPath, progress);
      continue;
    }

    // Phase 2: Label with LLM
    console.log(`  Labeling ${segments.length} segments...`);
    const labeled = await labelSegments(client, segments);
    console.log(`  ${labeled.length} labeled successfully`);

    allSegments.push(...labeled);
    progress.labeledSegments = allSegments;
    progress.completedFiles.push(file);
    saveProgress(progressPath, progress);
  }

  console.log(`\nTotal labeled segments: ${allSegments.length}`);

  // Phase 3: Deduplicate Q&A pairs across all files
  console.log('\n--- Phase 2: Deduplicate Q&A ---');
  const totalQA = allSegments.reduce(
    (sum, seg) => sum + seg.qaPairs.length,
    0,
  );
  console.log(`Total Q&A pairs before dedup: ${totalQA}`);

  const deduplicated = await deduplicateQAPairs(client, allSegments);
  console.log(`After dedup: ${deduplicated.length} canonical Q&A pairs`);

  // Phase 4: Generate output
  console.log('\n--- Phase 3: Generate Output ---');
  const { conversationFiles, faqFiles } = generateOutput(
    outputDir,
    allSegments,
    deduplicated,
  );

  console.log(`\nOutput written to: ${outputDir}`);
  console.log(`  ${conversationFiles.length} conversation files`);
  console.log(`  ${faqFiles.length} FAQ files`);
  console.log(
    '\nNext steps:',
    '\n  1. Review the output files',
    '\n  2. Upload to R2: POST /documents with each .md file',
    '\n  3. Trigger indexing: POST /documents/sync',
  );
}

function saveProgress(path: string, progress: Progress): void {
  writeFileSync(path, JSON.stringify(progress, null, 2), 'utf-8');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
