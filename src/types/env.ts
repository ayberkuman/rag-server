export type Env = {
  Bindings: {
    AI: Ai;
    DOCUMENTS_BUCKET: R2Bucket;
    VERIFY_TOKEN: string;
    AI_SEARCH_INSTANCE_ID: string;
    // For AI Search REST API (sync & jobs)
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;
    // KV namespaces
    CONVERSATIONS_KV: KVNamespace;
    LEADS_KV: KVNamespace;
    // Anthropic
    ANTHROPIC_API_KEY: string;
    // WhatsApp Cloud API
    WHATSAPP_ACCESS_TOKEN: string;
    WHATSAPP_PHONE_NUMBER_ID: string;
    // Doctor config
    DOCTOR_NAME: string;
    DOCTOR_LEAD_WEBHOOK_URL?: string;
    // Admin
    ADMIN_API_KEY: string;
  };
};

interface Ai {
  autorag(instanceId: string): AutoRAG;
}

interface AutoRAG {
  aiSearch(options: AiSearchOptionsStreaming): Promise<Response>;
  aiSearch(options: AiSearchOptions): Promise<AiSearchResult>;
  search(options: AiSearchSearchOptions): Promise<AiSearchSearchResult>;
}

export interface AiSearchOptions {
  query: string;
  model?: string;
  system_prompt?: string;
  max_num_results?: number;
  match_threshold?: number;
  stream?: boolean;
}

export interface AiSearchOptionsStreaming extends Omit<AiSearchOptions, 'stream'> {
  stream: true;
}

export interface AiSearchResult {
  response: string;
  data: AiSearchDocument[];
}

export interface AiSearchSearchOptions {
  query: string;
  max_num_results?: number;
  match_threshold?: number;
}

export interface AiSearchSearchResult {
  data: AiSearchDocument[];
}

export interface AiSearchDocument {
  file_id: string;
  filename: string;
  score: number;
  content: Array<{
    id: string;
    type: string;
    text: string;
  }>;
}
