# WhatsApp Sales/Support Agent for Doctors — System Design Plan

## Context

This is a prototype for a 24/7 WhatsApp customer support/sales agent for doctors. The doctor exports their past WhatsApp conversations, which get fed into a RAG (Cloudflare AI Search). A Source of Truth markdown doc contains verified info (treatments, prices, hours). The agent receives incoming WhatsApp messages, reasons about them using Claude, and responds using tools (RAG search, source of truth lookup, lead capture).

**Key decisions:**
- One deployment per doctor (separate Worker + AI Search instance)
- Claude API (Anthropic) for agent reasoning and tool-use
- Conversation history stored in Cloudflare KV (WhatsApp API has no history endpoint)
- Both tone/style matching AND FAQ extraction from past conversations
- Source of Truth as markdown in R2
- Capabilities: informational responses + lead capture

---

## Architecture Overview

```
WhatsApp Cloud API
       │
       ▼
  POST /webhook  ──→  return 200 immediately
       │
       ▼ (via waitUntil)
  Fetch conversation history from KV
       │
       ▼
  Claude Agent (AI SDK generateText + tool_use)
       │    System prompt includes Source of Truth doc (fetched from R2 once)
       │
       ├──→ Tool: search_knowledge_base  (Cloudflare AI Search — retrieval only)
       ├──→ Tool: capture_lead            (KV write + optional webhook notify)
       │
       ▼
  Send reply via WhatsApp Cloud API
  Store assistant message in KV conversation history
```

---

## New/Modified Files

```
src/
  index.ts                          [MODIFY] — add /admin route group
  types/
    env.ts                          [MODIFY] — add new bindings (KV, Anthropic key, WhatsApp creds)
    whatsapp.ts                     [MODIFY] — add outbound message types
    agent.ts                        [NEW]    — agent types (tool definitions, conversation)
  services/
    ai-search.ts                    [MODIFY] — expose search-only mode (no LLM generation)
    whatsapp.ts                     [NEW]    — send messages + conversation history via KV
    claude-agent.ts                 [NEW]    — core agent loop using Anthropic Messages API
    lead-capture.ts                 [NEW]    — KV operations for leads
    message-queue.ts                [NEW]    — abuse detection + impatient patient queue
  routes/
    webhook.ts                      [MODIFY] — rewrite with waitUntil pattern + agent
    test.ts                         [MODIFY] — use new agent for testing
    admin.ts                        [NEW]    — leads CRUD, SoT management
scripts/
  preprocess-chats/
    index.ts                        [NEW]    — CLI entry point
    parse.ts                        [NEW]    — WhatsApp .txt parser
    segment.ts                      [NEW]    — topic segmentation within each file
    label.ts                        [NEW]    — LLM labeling (Haiku batch)
    dedup.ts                        [NEW]    — Q&A deduplication across all files
    output.ts                       [NEW]    — generate final markdown files
```

---

## Component Details

### 1. Environment & Bindings

Add to `wrangler.jsonc`:
- `LEADS_KV` — KV namespace for lead storage
- `CONVERSATIONS_KV` — KV namespace for conversation history (no TTL, rolling window of last 50 messages per phone number)

New env vars (secrets):
- `ANTHROPIC_API_KEY`
- `WHATSAPP_ACCESS_TOKEN` (Meta Graph API token)
- `WHATSAPP_PHONE_NUMBER_ID`
- `DOCTOR_NAME`
- `DOCTOR_LEAD_WEBHOOK_URL` (optional, for lead notifications)
- `ADMIN_API_KEY` (protects admin endpoints)

### 2. Claude Agent (`src/services/claude-agent.ts`)

Uses **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic` + `zod`) for the agent loop.

**Why AI SDK:**
- Automatic tool execution loop via `maxSteps` — no manual "call → check tool_use → execute → call again" boilerplate
- Zod schemas for type-safe tool parameters with validation
- Built-in retries (`maxRetries`) on transient failures
- Easy provider switching — swap `anthropic()` for `openai()` to test different models, zero code changes
- Edge runtime compatible (works on Cloudflare Workers)

**Dependencies to add:**
```
ai                    — core SDK
@ai-sdk/anthropic     — Claude provider
zod                   — schema validation (used by AI SDK for tool params)
```

**Model:** Claude Sonnet via `anthropic('claude-sonnet-4-20250514')` — best speed/cost/quality for real-time chat.

**Tools (defined with Zod schemas):**

| Tool | Purpose | Data Source |
|------|---------|-------------|
| `search_knowledge_base` | Search past conversations + FAQ for informational retrieval | Cloudflare AI Search (`.search()` — retrieval only) |
| `capture_lead` | Record interested patient for doctor follow-up | KV write |

**Source of Truth:** No longer a tool. The SoT markdown doc is fetched from R2 once at the start of each request and injected directly into the system prompt. A 2-page doc is ~1,500-2,000 tokens — negligible in Claude's 200K context window (~$0.005 extra per message). This means the agent always has the doctor's info without needing a tool call.

**Agent implementation:**
```ts
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// Fetch Source of Truth from R2 once, inject into system prompt
const sotDoc = await env.DOCUMENTS_BUCKET.get('source-of-truth.md');
const sotContent = await sotDoc.text();
const fullSystemPrompt = `${systemPrompt}\n\n## Doctor's Practice Information\n${sotContent}`;

const result = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  system: fullSystemPrompt,
  messages: conversationHistory,
  maxSteps: 5,       // max tool iterations
  maxRetries: 2,     // auto-retry on transient errors
  tools: {
    search_knowledge_base: {
      description: 'Search the doctor\'s past conversations and FAQ...',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        return await searchKnowledgeBase(ai, instanceId, query);
      },
    },
    capture_lead: {
      description: 'Record a potential patient\'s interest for doctor follow-up...',
      parameters: z.object({
        patient_name: z.string(),
        phone_number: z.string(),
        interest: z.string(),
        urgency: z.enum(['low', 'medium', 'high']).optional(),
        notes: z.string().optional(),
      }),
      execute: async (params) => {
        return await captureLead(leadsKv, params);
      },
    },
  },
});

// result.text contains the final response — SDK handled the full tool loop
```

**System prompt highlights:**
- WhatsApp-style short messages, warm tone
- Tone and style controlled entirely from the system prompt (not from RAG results)
- Respond in the same language the customer writes in (primarily Turkish, occasional English)
- Never diagnose or give medical advice
- Never make up prices/info — check Source of Truth (in system prompt) or use search tool
- Capture lead when patient shows booking intent
- Direct emergencies to emergency services
- If tool calls return no useful results, respond honestly that the doctor's team will follow up — don't keep searching

**Language strategy:**
- System prompt & tool descriptions → English (Claude follows instructions most reliably in English)
- Source of Truth document → Turkish (doctor writes it, agent quotes from it)
- Preprocessed conversation docs & Q&A pairs → Turkish (original language preserved)
- Metadata labels from preprocessing → English (category names like `pricing_inquiry`)

**Token budget:** ~7,000–14,000 tokens per request (system+SoT ~2,500, tools ~500, history 50 msgs ~5,000–8,000, RAG results ~1,000–3,000, output ~200–500). Well within Claude's 200K context window.

### 3. AI Search Modifications (`src/services/ai-search.ts`)

Switch from `aiSearch()` (retrieval + LLM generation via Llama) to **`.search()` method** (confirmed available on AutoRAG binding). Returns raw document chunks without LLM generation — Claude handles all reasoning.

**Tool result formatting:** Include the metadata labels from preprocessing alongside the content. Claude sees the category, treatment, and tone tags to better understand each result:

```
[Result 1 | category: pricing_inquiry | treatment: botox | tone: warm, informative]
Patient: Botoks fiyatı ne kadar?
Doctor: Merhaba, botoks uygulamalarımız 3000 TL'den başlıyor...

[Result 2 | type: faq | category: pricing | treatment: botox]
Q: Botoks fiyatı ne kadar?
A: Botoks uygulamaları 3000 TL'den başlıyor...
```

This metadata is the whole reason we did LLM preprocessing — pass it through to Claude so it can calibrate responses based on category and context.

### 4. Conversation History (`src/services/whatsapp.ts`)

WhatsApp Cloud API has **no history endpoint**. Store conversation in KV instead:
- Key: `conv:{phone_number}` → JSON array of `{role, content, timestamp, name}`
- Append on every incoming message and outbound reply
- No TTL — patients may take days to respond about medical decisions
- Rolling window: keep last 50 messages per phone number, trim oldest on append
- When building agent context, send all 50 messages (within token budget)

**Sending replies:**
```
POST https://graph.facebook.com/v21.0/{phone_number_id}/messages
```
Split at sentence boundaries if response exceeds 4096 char WhatsApp limit.

### 5. RAG Data Pipeline — WhatsApp Chat Preprocessing

**Important context:** WhatsApp only allows exporting one chat at a time. The doctor will provide **hundreds of individual .txt files**, each being the full chat history with one patient.

**Input:** Hundreds of `.txt` files, each = one patient's entire conversation history with the doctor. Format: `[date, time] Sender: message`

**Processing runs as a local script** (`scripts/preprocess-chats/`), not in the Worker. This is a one-time batch job per doctor onboarding.

#### Pipeline

```
Doctor provides hundreds of .txt files (one per patient chat)
              │
              ▼
   Local preprocessing script (Node/TS)
              │
   ┌──────────┼──────────────┐
   ▼          ▼              ▼
 Parse      Extract patient  Segment by topic/time
 messages   name from        within each file
            filename         (>2-4h gap = new topic)
              │
              ▼
   LLM labeling (Claude Haiku, batch)
   For each topic segment:
   - Categorize (pricing inquiry, appointment, follow-up, complaint, etc.)
   - Extract Q&A pairs
   - Summarize in one line
   - Tag tone (formal, casual, empathetic)
   - Merge/split segments if LLM identifies better boundaries
              │
              ▼
   LLM deduplication pass
   - Compare Q&As across ALL files
   - Merge near-duplicates, keep most complete/recent answer
   - (Same question from different patients → one canonical Q&A)
              │
              ▼
   Output: folder of structured .md files
              │
              ▼
   Bulk upload to R2 → trigger AI Search sync
```

#### Output document format (two types)

**1. Conversation segments** — for tone/style matching:
```markdown
---
type: conversation
date: 2024-01-15
patient: Ahmet Yilmaz
category: pricing_inquiry
treatment: botox
summary: Patient asked about botox pricing and duration
tone: warm, informative
---
# Conversation: Botox Pricing Inquiry (Jan 15, 2024)
**Ahmet Yilmaz** (14:32): Botox fiyatlari hakkinda bilgi alabilir miyim?
**Dr. Ayse** (14:35): Tabii, botox uygulamalarimiz 3000 TL'den basliyor...
```
Stored as `conversations/ahmet-yilmaz_2024-01-15_botox-pricing.md` in R2.

**2. Deduplicated Q&A pairs** — for precise factual retrieval:
```markdown
---
type: faq
category: pricing
treatment: botox
sources: [ahmet-yilmaz_2024-01-15, mehmet-kaya_2024-02-03]
---
**Q: How much does botox cost?**
A: Botox treatments start from 3,000 TL. The exact price depends on the area and number of units needed.
```

**Why dual indexing:** Conversation segments give tone/style matching. Deduplicated Q&A pairs give precise factual retrieval. Together they serve both RAG purposes.

**Why LLM preprocessing matters:** Well-labeled, categorized documents with summaries produce much better vector embeddings than raw timestamped chat messages. When a patient asks "how much is botox?", AI Search matches against `category: pricing_inquiry, treatment: botox` — far more precise than raw messages.

**Estimated cost:** Hundreds of files × ~3-5 segments each = ~500-2,000 LLM calls via Haiku. ~$2-5 total per doctor onboarding.

#### Script structure (`scripts/preprocess-chats/`)
- `parse.ts` — parse WhatsApp .txt format into structured messages
- `segment.ts` — split each file into topic segments by time gaps
- `label.ts` — LLM labeling of each segment (category, summary, tone, Q&A extraction)
- `dedup.ts` — LLM deduplication pass across all Q&A pairs
- `output.ts` — generate final markdown files
- `index.ts` — CLI entry point: `npx tsx scripts/preprocess-chats/index.ts ./chat-exports/ ./output/`

**Crash recovery:** Script writes a `progress.json` checkpoint file as it processes. Tracks which files have been completed. On restart, skips already-processed files. Each output `.md` file is written immediately after processing (not batched in memory). A crash loses at most one file's work.

**Config:** Anthropic API key loaded from `.env` file in the script directory (added to `.gitignore`).

### 6. Source of Truth

Lives at `source-of-truth.md` in R2. **Not indexed by AI Search** — kept separate to avoid conflicts with conversation data. Fetched once per request from R2 and injected into the system prompt.

The doctor writes this in Turkish. Free-form markdown — no fixed template. Typical sections: treatments, pricing, hours, location, policies, credentials, contact. But the doctor can structure it however they want.

Uploaded/updated via `POST /documents` with key `source-of-truth.md`. No sync needed since it's not in AI Search.

### 7. Lead Capture (`src/services/lead-capture.ts`)

**KV storage scheme:**
- `lead:{id}` → JSON Lead object (name, phone, interest, urgency, notes, status, timestamp)
- `leads:index` → JSON array of lead IDs (sorted by recency)
- `leads:phone:{phone}` → lead ID (dedup)

**Lead statuses:** new → contacted → converted/dismissed

**Doctor notification:** Fire-and-forget POST to `DOCTOR_LEAD_WEBHOOK_URL` (Slack webhook, email, or WhatsApp message to doctor). Failure doesn't block patient response.

### 8. Webhook Rewrite (`src/routes/webhook.ts`)

Critical change: **return 200 immediately**, process via `waitUntil`:
```ts
c.executionCtx.waitUntil(processMessages(payload, c.env));
return c.text('OK', 200);
```
WhatsApp expects fast responses; agent processing takes 2–5 seconds.

Add message deduplication via KV (store message ID with short TTL, skip if already seen).

**Error handling fallback:** Wrap the agent call in try/catch. On any failure (Claude API down, rate limited, unexpected error), send a fallback WhatsApp message: "Şu anda sistemimizde bir sorun yaşıyoruz. En kısa sürede size dönüş yapılacaktır." (We're experiencing a technical issue. Someone will get back to you shortly.) Log the error for monitoring. A 24/7 service cannot have silent failures — the patient must always get a response.

### 9. Rate Limiting & Message Queue (`src/services/message-queue.ts`)

Hybrid approach to handle both abuse and impatient patients:

**Layer 1: Abuse detection (drop)**
- KV counter `msgcount:{phone}` with 1-minute TTL
- Increment on every incoming message
- If count > 15 messages/minute → drop silently, don't process
- On first threshold hit, send one message: "Çok fazla mesaj gönderiyorsunuz, lütfen biraz bekleyin."
- Then silence until counter resets

**Layer 2: Impatient patient queue (batch)**
- When agent is already processing for a phone number (`processing:{phone}` lock in KV), don't start a new agent call
- Append new message to `queue:{phone}` in KV
- When current agent call finishes:
  1. Check `queue:{phone}`
  2. If messages waiting, grab all of them
  3. They're already in conversation history in KV — feed to agent as a batch
  4. Agent sees all queued messages and gives one coherent reply to all

**Result:** Patient who sends "merhaba", "botoks fiyatı ne?", "yüz bölgesi için" in quick succession gets one combined answer instead of three separate replies. Abusers get dropped after one warning.

**KV keys used:**
- `msgcount:{phone}` → number (1-min TTL)
- `processing:{phone}` → "1" (30s TTL as safety, deleted on completion)
- `queue:{phone}` → JSON array of queued message texts

### 10. Admin Routes (`src/routes/admin.ts`)

Protected by `ADMIN_API_KEY` bearer token.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/leads` | GET | List leads (with `?status=` filter) |
| `/admin/leads/:id` | GET/PATCH | View or update lead status |
| `/admin/source-of-truth` | GET/POST | View or update the SoT markdown |

Note: Chat export preprocessing runs locally via `scripts/preprocess-chats/`. The preprocessed `.md` files are uploaded to R2 via the existing `POST /documents` endpoint, then synced via `POST /documents/sync`.

---

## Implementation Phases

### Phase 1: Foundation
1. Install dependencies: `ai`, `@ai-sdk/anthropic`, `zod`
2. Update `types/env.ts` with new bindings
3. Update `wrangler.jsonc` with KV namespaces
4. Create `services/whatsapp.ts` (send message + KV conversation history)
5. Create `services/lead-capture.ts` (KV CRUD)

### Phase 2: Agent Core
7. Create `types/agent.ts` (tool types, conversation types)
8. Modify `services/ai-search.ts` → search-only mode
9. Create `services/claude-agent.ts` (AI SDK `generateText` with tools + `maxSteps: 5`)

### Phase 3: Integration
10. Create `services/message-queue.ts` (abuse detection + patient message queue)
11. Rewrite `routes/webhook.ts` (waitUntil + agent + reply sending + error fallback + message queue)
12. Update `routes/test.ts` for new agent

### Phase 4: Data Pipeline + Admin
11. Create `scripts/preprocess-chats/` (local CLI tool: parse → segment → LLM label → dedup → output)
12. Create `routes/admin.ts` (leads CRUD, SoT management, bulk upload of preprocessed .md files to R2)
13. Update `index.ts` to mount `/admin`

### Phase 5: Polish
16. Message deduplication in webhook
17. Upload initial source-of-truth.md + chat exports for testing

---

## Key Decisions Summary

| Decision | Choice | Why |
|----------|--------|-----|
| Conversation history | KV (not WhatsApp API) | No history endpoint exists; KV is fast + auto-expires |
| Lead storage | KV (not D1) | Low volume, simple access, no migrations |
| Claude integration | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `zod`) | Auto tool loop via `maxSteps`, retries, Zod validation, easy provider switching for testing |
| Claude model | Sonnet | Best speed/cost/quality for real-time chat |
| AI Search mode | Search-only (not aiSearch) | Avoid double-LLM; Claude is the reasoner |
| Chat export processing | Local script: parse → segment → LLM label → dedup → structured .md files | Better retrieval; LLM-labeled docs produce superior embeddings |
| Source of truth | In system prompt (fetched from R2 once per request) | Always available, no tool call needed, ~1,500-2,000 tokens is negligible |
| Webhook pattern | waitUntil | WhatsApp needs fast 200; agent takes 2–5s |

---

## Verification

1. **Unit test chat parser:** Feed sample WhatsApp .txt export, verify correct segmentation and markdown output
2. **Test agent loop:** Use `/test` endpoint with sample messages, verify tool selection logic (pricing question → source of truth, style question → AI search, booking intent → lead capture, greeting → direct response)
3. **End-to-end:** Send WhatsApp message → verify response arrives back in WhatsApp with correct content
4. **Lead capture:** Verify leads appear in `GET /admin/leads` after agent captures them
5. **Conversation continuity:** Send multiple messages, verify agent references prior conversation context
