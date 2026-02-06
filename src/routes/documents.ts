import { Hono } from "hono";
import {
  deleteDocument,
  getJobDetails,
  getJobLogs,
  listDocuments,
  listJobs,
  triggerSync,
  uploadDocument,
} from "../services/documents";
import type { Env } from "../types/env";

const documents = new Hono<Env>();

// Supported file types for AI Search
const SUPPORTED_CONTENT_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "application/json": ".json",
  "text/csv": ".csv",
};

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB limit for AI Search

/**
 * GET /documents - List all documents in the bucket
 */
documents.get("/", async (c) => {
  const prefix = c.req.query("prefix");
  const limit = c.req.query("limit");
  const cursor = c.req.query("cursor");

  const result = await listDocuments(c.env.DOCUMENTS_BUCKET, {
    prefix: prefix || undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    cursor: cursor || undefined,
  });

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }
  console.log(result);
  return c.json({
    objects: result.objects,
    cursor: result.cursor,
    truncated: result.truncated,
  });
});

/**
 * POST /documents - Upload a new document
 * Accepts multipart/form-data with a 'file' field
 */
documents.post("/", async (c) => {
  try {
    const contentType = c.req.header("Content-Type") || "";

    // Handle multipart form data
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");

      if (!file || !(file instanceof File)) {
        return c.json({ error: "No file provided" }, 400);
      }

      // Validate file type
      if (!SUPPORTED_CONTENT_TYPES[file.type]) {
        return c.json(
          {
            error: `Unsupported file type: ${file.type}. Supported types: ${Object.keys(SUPPORTED_CONTENT_TYPES).join(", ")}`,
          },
          400,
        );
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          {
            error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
          },
          400,
        );
      }

      // Use original filename or generate one
      const key = formData.get("key")?.toString() || file.name;

      const result = await uploadDocument(
        c.env.DOCUMENTS_BUCKET,
        key,
        await file.arrayBuffer(),
        file.type,
      );

      if (!result.success) {
        return c.json({ error: result.error }, 500);
      }

      return c.json(
        {
          message: "Document uploaded successfully",
          key: result.key,
          size: result.size,
          note: "Document will be indexed in the next sync cycle (auto every 6 hours, or trigger manually via POST /documents/sync)",
        },
        201,
      );
    }

    // Handle raw body upload with key in query param
    const key = c.req.query("key");
    if (!key) {
      return c.json(
        { error: "Key is required for raw uploads (use ?key=filename.pdf)" },
        400,
      );
    }

    const fileContentType =
      c.req.header("Content-Type") || "application/octet-stream";
    if (!SUPPORTED_CONTENT_TYPES[fileContentType]) {
      return c.json(
        {
          error: `Unsupported content type: ${fileContentType}`,
        },
        400,
      );
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        },
        400,
      );
    }

    const result = await uploadDocument(
      c.env.DOCUMENTS_BUCKET,
      key,
      body,
      fileContentType,
    );

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json(
      {
        message: "Document uploaded successfully",
        key: result.key,
        size: result.size,
      },
      201,
    );
  } catch (error) {
    console.error("Upload error:", error);
    return c.json({ error: "Failed to process upload" }, 500);
  }
});

/**
 * DELETE /documents/:key - Delete a document
 */
documents.delete("/:key{.+}", async (c) => {
  const key = c.req.param("key");

  const result = await deleteDocument(c.env.DOCUMENTS_BUCKET, key);

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    message: "Document deleted successfully",
    key,
    note: "Document will be removed from the index in the next sync cycle",
  });
});

/**
 * POST /documents/sync - Trigger AI Search indexing
 * Cooldown: 3 minutes between requests
 */
documents.post("/sync", async (c) => {
  const result = await triggerSync(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.AI_SEARCH_INSTANCE_ID,
  );

  if (!result.success) {
    const status = result.cooldownRemaining ? 429 : 500;
    return c.json(
      {
        error: result.error,
        cooldownRemaining: result.cooldownRemaining,
      },
      status,
    );
  }

  return c.json({
    message: "Sync triggered successfully",
    jobId: result.jobId,
    note: "Use GET /documents/jobs/:jobId to check indexing status",
  });
});

/**
 * GET /documents/jobs - List all indexing jobs
 */
documents.get("/jobs", async (c) => {
  const result = await listJobs(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.AI_SEARCH_INSTANCE_ID,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({ jobs: result.jobs });
});

/**
 * GET /documents/jobs/:jobId - Get job details
 */
documents.get("/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const result = await getJobDetails(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.AI_SEARCH_INSTANCE_ID,
    jobId,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({ job: result.job });
});

/**
 * GET /documents/jobs/:jobId/logs - Get job logs
 */
documents.get("/jobs/:jobId/logs", async (c) => {
  const jobId = c.req.param("jobId");

  const result = await getJobLogs(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CLOUDFLARE_API_TOKEN,
    c.env.AI_SEARCH_INSTANCE_ID,
    jobId,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({ logs: result.logs });
});

export { documents };
