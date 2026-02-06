export type Env = {
  Bindings: {
    AI: Ai;
    DOCUMENTS_BUCKET: R2Bucket;
    VERIFY_TOKEN: string;
    AI_SEARCH_INSTANCE_ID: string;
    // For AI Search REST API (sync & jobs)
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;
  };
};

interface Ai {
  autorag(instanceId: string): AutoRAG;
}

interface AutoRAG {
  aiSearch(options: AiSearchOptionsStreaming): Promise<Response>;
  aiSearch(options: AiSearchOptions): Promise<AiSearchResult>;
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
