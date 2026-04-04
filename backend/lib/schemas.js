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
}).superRefine((data, ctx) => {
  const thresholds = data.reviewThresholds;
  if (!thresholds) return;
  if (thresholds.auto != null && thresholds.manual != null && thresholds.manual < thresholds.auto) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewThresholds", "manual"],
      message: "manual threshold must be greater than or equal to auto",
    });
  }
  if (thresholds.manual != null && thresholds.admin != null && thresholds.admin < thresholds.manual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewThresholds", "admin"],
      message: "admin threshold must be greater than or equal to manual",
    });
  }
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
}).superRefine((data, ctx) => {
  if (data.action === "approve" && data.adjustedPayout != null && data.adjustedPayout <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adjustedPayout"],
      message: "adjustedPayout must be greater than zero when approving",
    });
  }
  if (data.action === "reject" && !data.reason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "reason is required when rejecting",
    });
  }
});

export const PolicySimulationSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  payout: z.number().positive(),
  chain: z.string().default("evm"),
  reporterWallet: z.string().min(1).max(100),
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
