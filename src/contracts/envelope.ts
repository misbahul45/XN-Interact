import * as z from "zod/v4";
import type { ErrorBody } from "./errors.ts";

export interface Meta {
  request_id: string;
  result_ref?: string;
  next_cursor?: string;
  warnings?: string[];
  usage?: { calls: number; estimated_cost?: number | null };
  bridge?: { outcome: string; error_class: string; partial?: boolean };
}

export interface ToolResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ErrorBody;
  meta: Meta;
}

export const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      category: z.string(),
      retryable: z.boolean(),
      bridge_error_class: z.string(),
      message: z.string(),
    })
    .loose()
    .optional(),
  meta: z
    .object({ request_id: z.string() })
    .loose(),
});
