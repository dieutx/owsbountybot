import { z } from "zod";

export const CreateProgramSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  maxPerBug: z.number().positive().optional().default(150),
  dailyLimit: z.number().positive().optional().default(500),
  allowedChains: z.array(z.string()).optional(),
  reviewThresholds: z.object({
    auto: z.number().nonnegative().optional(),
    manual: z.number().nonnegative().optional(),
    admin: z.number().nonnegative().optional(),
  }).optional(),
});

export const SubmitReportSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: z.string().min(1).max(5000),
  reporterWallet: z.string().min(1).max(100),
  chain: z.string().default("evm"),
  affectedAsset: z.string().max(500).optional(),
  vulnClass: z.string().max(100).optional(),
});

export const ReviewReportSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reviewedBy: z.string().min(1).max(100).optional().default("admin"),
  reason: z.string().max(1000).optional(),
  adjustedPayout: z.number().nonnegative().optional(),
});

// Validate and return { success, data, error }
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data, error: null };
  }
  const messages = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
  return { success: false, data: null, error: messages.join("; ") };
}
