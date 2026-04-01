import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Env } from '../types/env';
import type { AgentResponse, ConversationMessage } from '../types/agent';
import { searchKnowledgeBase } from './ai-search';
import { captureLead, notifyDoctor } from './lead-capture';
import type { ModelMessage } from '@ai-sdk/provider-utils';

const SYSTEM_PROMPT = `You are a WhatsApp customer support and sales assistant for a medical practice.
You work on behalf of the doctor to answer patient inquiries 24/7.

## Core Rules
- Respond in the SAME LANGUAGE the patient writes in (primarily Turkish, occasionally English)
- Use WhatsApp-style short messages — warm, professional tone
- NEVER diagnose, give medical advice, or suggest treatments
- NEVER make up prices, hours, or any factual info — only use the Doctor's Practice Information below or the search tool
- If you don't have the answer, honestly say the doctor's team will follow up — do NOT keep searching
- Direct emergencies to 112 (Turkish emergency services)

## When to Capture Leads
When a patient expresses intent to book, schedule, or seriously inquire about a treatment,
use the capture_lead tool. Indicators: asking for available dates, saying they want to come in,
requesting a call-back, expressing urgency about a procedure.

## Response Style
- Keep messages concise (1-3 short paragraphs max)
- Use a warm, empathetic but professional tone
- Mirror the doctor's communication style from past conversations
- It's OK to use common Turkish expressions like "Merhaba", "Tabii ki", etc. when responding in Turkish

## Tool Usage
- Use search_knowledge_base when a patient asks about treatments, prices, procedures, or anything clinical
- If the search returns no useful results, respond honestly — do not re-search with different queries
- The Doctor's Practice Information section below is your primary source of truth — check it FIRST before searching`;

function buildSystemPrompt(sourceOfTruth: string, doctorName: string): string {
  return `${SYSTEM_PROMPT}

## Doctor's Practice Information
Doctor: ${doctorName}

${sourceOfTruth}`;
}

function conversationToMessages(history: ConversationMessage[]): ModelMessage[] {
  return history.map((msg) => {
    if (msg.role === 'user') {
      return { role: 'user' as const, content: msg.content };
    }
    return { role: 'assistant' as const, content: msg.content };
  });
}

export async function createAgent(env: Env['Bindings']) {
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Fetch Source of Truth from R2
  const sotObject = await env.DOCUMENTS_BUCKET.get('source-of-truth.md');
  const sourceOfTruth = sotObject ? await sotObject.text() : 'No practice information available yet.';

  const instructions = buildSystemPrompt(sourceOfTruth, env.DOCTOR_NAME);

  return new ToolLoopAgent({
    id: 'whatsapp-support-agent',
    model: anthropic('claude-sonnet-4-20250514'),
    instructions,
    stopWhen: stepCountIs(5),
    tools: {
      search_knowledge_base: tool({
        description:
          "Search the doctor's past conversations and FAQ database for information about treatments, pricing, procedures, availability, and other practice-related questions. Use this when the patient asks something not covered in the system prompt.",
        inputSchema: z.object({
          query: z.string().describe('The search query based on the patient question'),
        }),
        execute: async ({ query }) => {
          const result = await searchKnowledgeBase(
            env.AI,
            env.AI_SEARCH_INSTANCE_ID,
            query,
          );
          return result.formattedText;
        },
      }),

      capture_lead: tool({
        description:
          "Record a potential patient's interest for doctor follow-up. Use when a patient shows booking intent, wants to schedule an appointment, requests a callback, or seriously inquires about a specific treatment.",
        inputSchema: z.object({
          patient_name: z.string().describe('Name of the patient'),
          phone_number: z.string().describe('Phone number of the patient (WhatsApp number)'),
          interest: z.string().describe('What the patient is interested in (e.g., "botox consultation", "rhinoplasty pricing")'),
          urgency: z
            .enum(['low', 'medium', 'high'])
            .optional()
            .describe('How urgent the inquiry seems: low=general interest, medium=wants to book soon, high=urgent/time-sensitive'),
          notes: z
            .string()
            .optional()
            .describe('Additional context about the patient interaction'),
        }),
        execute: async ({ patient_name, phone_number, interest, urgency, notes }) => {
          const result = await captureLead(env.LEADS_KV, {
            patient_name,
            phone_number,
            interest,
            urgency,
            notes,
          });

          // Fire-and-forget webhook notification
          if (env.DOCTOR_LEAD_WEBHOOK_URL && !result.isExisting) {
            const lead = {
              id: result.leadId,
              patientName: patient_name,
              phoneNumber: phone_number,
              interest,
              urgency: urgency ?? 'medium',
              notes,
              status: 'new' as const,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            notifyDoctor(env.DOCTOR_LEAD_WEBHOOK_URL, lead);
          }

          return result.isExisting
            ? `Lead updated for ${patient_name} (existing patient).`
            : `New lead captured for ${patient_name}. The doctor will be notified.`;
        },
      }),
    },
  });
}

export async function runAgent(
  env: Env['Bindings'],
  conversationHistory: ConversationMessage[],
  currentMessage: string,
  customerName: string,
  phoneNumber: string,
): Promise<AgentResponse> {
  const agent = await createAgent(env);

  // Build messages from conversation history + current message
  const messages: ModelMessage[] = [
    ...conversationToMessages(conversationHistory),
    {
      role: 'user' as const,
      content: `[Patient: ${customerName}, Phone: ${phoneNumber}]\n${currentMessage}`,
    },
  ];

  const result = await agent.generate({ messages });

  return {
    text: result.text,
    toolCalls: result.steps.reduce(
      (count, step) => count + (step.toolCalls?.length ?? 0),
      0,
    ),
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
    },
  };
}
