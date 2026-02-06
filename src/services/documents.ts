import type { Env } from '../types/env';

const AI_SEARCH_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export interface SyncResponse {
  success: boolean;
  jobId?: string;
  error?: string;
  cooldownRemaining?: number;
}

export interface Job {
  id: string;
  source: string;
  end_reason?: string;
  created_at: string;
  updated_at: string;
  status?: string;
}

export interface JobsListResponse {
  success: boolean;
  jobs?: Job[];
  error?: string;
}

export interface JobDetailsResponse {
  success: boolean;
  job?: Job;
  error?: string;
}

export interface JobLog {
  id: string;
  created_at: string;
  message: string;
  level?: string;
}

export interface JobLogsResponse {
  success: boolean;
  logs?: JobLog[];
  error?: string;
}

export interface UploadResponse {
  success: boolean;
  key?: string;
  size?: number;
  error?: string;
}

/**
 * Upload a document to R2 bucket
 */
export async function uploadDocument(
  bucket: Env['Bindings']['DOCUMENTS_BUCKET'],
  key: string,
  data: ReadableStream | ArrayBuffer | string,
  contentType: string
): Promise<UploadResponse> {
  try {
    const result = await bucket.put(key, data, {
      httpMetadata: {
        contentType,
      },
    });

    if (!result) {
      throw new Error('Failed to upload document');
    }

    return {
      success: true,
      key: result.key,
      size: result.size,
    };
  } catch (error) {
    console.error('Upload error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Delete a document from R2 bucket
 */
export async function deleteDocument(
  bucket: Env['Bindings']['DOCUMENTS_BUCKET'],
  key: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await bucket.delete(key);
    return { success: true };
  } catch (error) {
    console.error('Delete error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * List documents in R2 bucket
 */
export async function listDocuments(
  bucket: Env['Bindings']['DOCUMENTS_BUCKET'],
  options?: { prefix?: string; limit?: number; cursor?: string }
): Promise<{
  success: boolean;
  objects?: { key: string; size: number; uploaded: Date }[];
  cursor?: string;
  truncated?: boolean;
  error?: string;
}> {
  try {
    const result = await bucket.list({
      prefix: options?.prefix,
      limit: options?.limit || 100,
      cursor: options?.cursor,
    });

    return {
      success: true,
      objects: result.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
      })),
      cursor: result.truncated ? result.cursor : undefined,
      truncated: result.truncated,
    };
  } catch (error) {
    console.error('List error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Trigger AI Search sync/indexing via REST API
 * Cooldown: 3 minutes between sync requests
 */
export async function triggerSync(
  accountId: string,
  apiToken: string,
  ragName: string
): Promise<SyncResponse> {
  try {
    const response = await fetch(
      `${AI_SEARCH_API_BASE}/${accountId}/autorag/rags/${ragName}/sync`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = (await response.json()) as {
      success: boolean;
      result?: { job_id: string };
      errors?: { message: string; code?: number }[];
    };

    if (!response.ok || !data.success) {
      const errorMsg = data.errors?.[0]?.message || 'Sync request failed';
      // Check if it's a cooldown error
      if (errorMsg.includes('cooldown') || response.status === 429) {
        return {
          success: false,
          error: 'Sync is in cooldown period. Please wait 3 minutes between sync requests.',
          cooldownRemaining: 180, // 3 minutes in seconds
        };
      }
      return { success: false, error: errorMsg };
    }

    return {
      success: true,
      jobId: data.result?.job_id,
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * List AI Search indexing jobs via REST API
 */
export async function listJobs(
  accountId: string,
  apiToken: string,
  ragName: string
): Promise<JobsListResponse> {
  try {
    const response = await fetch(
      `${AI_SEARCH_API_BASE}/${accountId}/autorag/rags/${ragName}/jobs`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      }
    );

    const data = (await response.json()) as {
      success: boolean;
      result?: Job[];
      errors?: { message: string }[];
    };

    if (!response.ok || !data.success) {
      return {
        success: false,
        error: data.errors?.[0]?.message || 'Failed to list jobs',
      };
    }

    return {
      success: true,
      jobs: data.result || [],
    };
  } catch (error) {
    console.error('List jobs error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get AI Search job details via REST API
 */
export async function getJobDetails(
  accountId: string,
  apiToken: string,
  ragName: string,
  jobId: string
): Promise<JobDetailsResponse> {
  try {
    const response = await fetch(
      `${AI_SEARCH_API_BASE}/${accountId}/autorag/rags/${ragName}/jobs/${jobId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      }
    );

    const data = (await response.json()) as {
      success: boolean;
      result?: Job;
      errors?: { message: string }[];
    };

    if (!response.ok || !data.success) {
      return {
        success: false,
        error: data.errors?.[0]?.message || 'Failed to get job details',
      };
    }

    return {
      success: true,
      job: data.result,
    };
  } catch (error) {
    console.error('Get job details error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get AI Search job logs via REST API
 */
export async function getJobLogs(
  accountId: string,
  apiToken: string,
  ragName: string,
  jobId: string
): Promise<JobLogsResponse> {
  try {
    const response = await fetch(
      `${AI_SEARCH_API_BASE}/${accountId}/autorag/rags/${ragName}/jobs/${jobId}/logs`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      }
    );

    const data = (await response.json()) as {
      success: boolean;
      result?: JobLog[];
      errors?: { message: string }[];
    };

    if (!response.ok || !data.success) {
      return {
        success: false,
        error: data.errors?.[0]?.message || 'Failed to get job logs',
      };
    }

    return {
      success: true,
      logs: data.result || [],
    };
  } catch (error) {
    console.error('Get job logs error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
