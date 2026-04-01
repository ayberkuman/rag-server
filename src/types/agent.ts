export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  name?: string;
}

export interface Lead {
  id: string;
  patientName: string;
  phoneNumber: string;
  interest: string;
  urgency: 'low' | 'medium' | 'high';
  notes?: string;
  status: 'new' | 'contacted' | 'converted' | 'dismissed';
  createdAt: number;
  updatedAt: number;
}

export interface AgentResponse {
  text: string;
  toolCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}
