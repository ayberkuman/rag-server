import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  queryCustomerSupport,
  queryCustomerSupportStream,
} from "../services/ai-search";
import type { Env } from "../types/env";

const test = new Hono<Env>();

// GET /test - Simple test endpoint with query parameter
test.get("/", async (c) => {
  const query = c.req.query("q");

  if (!query) {
    return c.json({
      message: "Customer Support Agent Test Endpoint",
      usage: "GET /test?q=your question here",
      example: "GET /test?q=What are your business hours?",
    });
  }

  const response = await queryCustomerSupport(
    c.env.AI,
    c.env.AI_SEARCH_INSTANCE_ID,
    query,
  );

  return c.json({
    query,
    response: response.answer,
    success: response.success,
    ...(response.error && { error: response.error }),
  });
});

// GET /test/stream - Streaming test endpoint
test.get("/stream", (c) => {
  const query = c.req.query("q");

  if (!query) {
    return c.json({
      message: "Streaming Customer Support Test Endpoint",
      usage: "GET /test/stream?q=your question here",
    });
  }

  // Required for Cloudflare Workers streaming
  c.header("Content-Encoding", "Identity");

  return stream(c, async (s) => {
    s.onAbort(() => {
      console.log("Stream aborted by client");
    });

    const response = await queryCustomerSupportStream(
      c.env.AI,
      c.env.AI_SEARCH_INSTANCE_ID,
      query,
    );

    if (!response.success) {
      await s.write(response.error || "An error occurred");
      return;
    }

    await s.pipe(response.stream);
  });
});

// POST /test - Test endpoint for simulating WhatsApp-like requests
test.post("/", async (c) => {
  try {
    const body = await c.req.json<{ message: string; name?: string; }>();

    if (!body.message) {
      return c.json({ error: "Message is required" }, 400);
    }

    const response = await queryCustomerSupport(
      c.env.AI,
      c.env.AI_SEARCH_INSTANCE_ID,
      body.message,
    );

    return c.json({
      customer: body.name || "Anonymous",
      question: body.message,
      answer: response.answer,
      success: response.success,
    });
  } catch (error) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

export { test };
