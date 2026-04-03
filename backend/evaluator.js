// Bug Report Evaluator
// Uses pattern matching + scoring heuristics for automated evaluation

import crypto from "crypto";

const SEVERITY_PAYOUTS = {
  critical: { min: 80, max: 150 },
  high:     { min: 40, max: 80 },
  medium:   { min: 15, max: 40 },
  low:      { min: 5, max: 15 },
};

const QUALITY_SIGNALS = {
  positive: [
    { pattern: /reproduce|steps to|how to trigger/i, weight: 2, label: "reproduction steps" },
    { pattern: /impact|exploit|vulnerability|attack/i, weight: 2, label: "impact analysis" },
    { pattern: /fix|patch|mitigation|recommendation/i, weight: 1.5, label: "suggested fix" },
    { pattern: /version|commit|hash|line \d+/i, weight: 1, label: "version specificity" },
    { pattern: /poc|proof of concept|payload/i, weight: 2.5, label: "proof of concept" },
    { pattern: /overflow|injection|xss|csrf|ssrf|rce|idor/i, weight: 2, label: "known vulnerability class" },
    { pattern: /authentication|authorization|privilege/i, weight: 1.5, label: "auth-related finding" },
  ],
  negative: [
    { pattern: /\bmaybe\b|\bmight\b|could be|not sure/i, weight: -1, label: "uncertain language" },
    { pattern: /\btest\b|\btesting\b|\bplaceholder\b/i, weight: -2, label: "test/placeholder content" },
    { pattern: /^.{0,50}$/s, weight: -3, label: "too short" },
  ],
};

function hashReport(title, description) {
  // Use null byte separator to prevent title/description boundary collisions (C-3)
  const normalized = `${title}\0${description}`.toLowerCase().replace(/\s+/g, '');
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function evaluateReport(report, {
  hasSeenHash = () => false,
  rememberHash = () => {},
} = {}) {
  const { title, severity, description } = report;
  const fullText = `${title} ${description}`;

  // Step 1: Duplicate check
  const reportHash = hashReport(title, description);
  if (hasSeenHash(reportHash)) {
    return {
      approved: false,
      payout: 0,
      severity,
      qualityScore: 0,
      reasoning: "DUPLICATE: This report matches a previously submitted finding. Duplicate reports are not eligible for bounty payouts.",
      signals: ["duplicate detection triggered"],
      evaluationTime: Date.now(),
    };
  }
  rememberHash(reportHash);

  // Step 2: Quality scoring
  let qualityScore = 5; // base score out of 10
  const detectedSignals = [];
  let hasPositiveSignal = false;

  for (const signal of QUALITY_SIGNALS.positive) {
    if (signal.pattern.test(fullText)) {
      qualityScore += signal.weight;
      detectedSignals.push(`✓ ${signal.label}`);
      hasPositiveSignal = true;
    }
  }

  for (const signal of QUALITY_SIGNALS.negative) {
    if (signal.pattern.test(fullText)) {
      qualityScore += signal.weight; // negative weight
      detectedSignals.push(`✗ ${signal.label}`);
    }
  }

  // Clamp score
  qualityScore = Math.max(0, Math.min(10, qualityScore));

  // Step 3: Decision — require at least one positive signal AND score >= 4 (L-3)
  const approved = qualityScore >= 4 && hasPositiveSignal;
  const severityRange = SEVERITY_PAYOUTS[severity] || SEVERITY_PAYOUTS.low;

  // Payout scales with quality score
  const payoutMultiplier = qualityScore / 10;
  const payout = approved
    ? Math.round(severityRange.min + (severityRange.max - severityRange.min) * payoutMultiplier)
    : 0;

  // Step 4: Generate reasoning
  let reasoning;
  if (!approved) {
    reasoning = `REJECTED: Quality score ${qualityScore.toFixed(1)}/10`;
    if (!hasPositiveSignal) {
      reasoning += ` — no positive quality signals detected.`;
    } else {
      reasoning += ` is below the minimum threshold of 4.0.`;
    }
    reasoning += ` The report lacks sufficient technical detail for a valid bug bounty submission. `;
    reasoning += `Detected issues: ${detectedSignals.filter(s => s.startsWith('✗')).join(', ') || 'insufficient detail'}.`;
  } else {
    reasoning = `APPROVED: Quality score ${qualityScore.toFixed(1)}/10. `;
    reasoning += `Severity: ${severity.toUpperCase()}. `;
    reasoning += `Positive signals: ${detectedSignals.filter(s => s.startsWith('✓')).join(', ')}. `;
    reasoning += `Recommended payout: $${payout} USDC based on ${severity} severity and report quality.`;
  }

  return {
    approved,
    payout,
    severity,
    qualityScore: Math.round(qualityScore * 10) / 10,
    reasoning,
    signals: detectedSignals,
    evaluationTime: Date.now(),
  };
}
