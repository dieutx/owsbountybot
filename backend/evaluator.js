// Bug Report Triage Engine
// Scores reports on quality, validates severity, recommends payout, and assigns confidence.
// Deterministic rules only — no LLM calls. Optional AI hooks can be added later.

import { detectVulnClass, extractAffectedAsset } from "./lib/fingerprint.js";

const SEVERITY_RANGES = {
  critical: { min: 80, max: 150 },
  high:     { min: 40, max: 80 },
  medium:   { min: 15, max: 40 },
  low:      { min: 5, max: 15 },
};

// Quality signals scored independently
const QUALITY_RULES = [
  { id: "repro_steps",  pattern: /\breproduce\b|\bsteps to\b|\bhow to trigger\b/i, weight: 2, category: "quality" },
  { id: "impact",       pattern: /\bimpact\b|\bexploit\b|\bvulnerability\b|\battack\b/i, weight: 2, category: "quality" },
  { id: "fix_suggest",  pattern: /\bfix\b|\bpatch\b|\bmitigation\b|\brecommendation\b/i, weight: 1.5, category: "quality" },
  { id: "version_spec", pattern: /\bversion\b|\bcommit\b|\bline \d+\b/i, weight: 1, category: "quality" },
  { id: "poc",          pattern: /\bpoc\b|\bproof of concept\b|\bpayload\b/i, weight: 2.5, category: "quality" },
  { id: "vuln_class",   pattern: /\boverflow\b|\binjection\b|\bxss\b|\bcsrf\b|\bssrf\b|\brce\b|\bidor\b/i, weight: 2, category: "quality" },
  { id: "auth_finding", pattern: /\bauthentication\b|\bauthorization\b|\bprivilege\b/i, weight: 1.5, category: "quality" },
];

const PENALTY_RULES = [
  { id: "uncertain",    pattern: /\bmaybe\b|\bmight\b|\bcould be\b|\bnot sure\b/i, weight: -1, category: "penalty" },
  { id: "test_content", pattern: /\btest\b|\btesting\b|\bplaceholder\b/i, weight: -2, category: "penalty" },
  { id: "too_short",    pattern: /^.{0,50}$/s, weight: -3, category: "penalty" },
];

export function evaluateReport(report) {
  const { title, severity, description, vulnClass: providedVulnClass, affectedAsset: providedAsset } = report;
  const fullText = `${title} ${description}`;

  // Step 1: Extract structured fields
  const vulnClass = providedVulnClass || detectVulnClass(fullText);
  const affectedAsset = providedAsset || extractAffectedAsset(fullText);

  // Step 2: Score quality
  let qualityScore = 5; // base
  const signals = [];
  let positiveCount = 0;

  for (const rule of QUALITY_RULES) {
    if (rule.pattern.test(fullText)) {
      qualityScore += rule.weight;
      signals.push({ id: rule.id, matched: true, weight: rule.weight });
      positiveCount++;
    }
  }

  for (const rule of PENALTY_RULES) {
    if (rule.pattern.test(fullText)) {
      qualityScore += rule.weight;
      signals.push({ id: rule.id, matched: true, weight: rule.weight });
    }
  }

  qualityScore = Math.max(0, Math.min(10, qualityScore));

  // Step 3: Calculate confidence
  // Confidence is higher when we have more data points
  const descLength = description.length;
  const lengthFactor = Math.min(1, descLength / 500); // max at 500 chars
  const signalFactor = Math.min(1, positiveCount / 4); // max at 4 positive signals
  const vulnFactor = vulnClass ? 0.15 : 0;
  const assetFactor = affectedAsset ? 0.1 : 0;
  const confidence = Math.round((lengthFactor * 0.25 + signalFactor * 0.4 + vulnFactor + assetFactor + 0.1) * 100) / 100;

  // Step 4: Decision
  const hasPositiveSignal = positiveCount > 0;
  const approved = qualityScore >= 4 && hasPositiveSignal;
  const needsManualReview = approved && confidence < 0.5;

  // Step 5: Payout recommendation
  const severityRange = SEVERITY_RANGES[severity] || SEVERITY_RANGES.low;
  const payoutMultiplier = qualityScore / 10;
  const recommendedPayout = approved
    ? Math.round(severityRange.min + (severityRange.max - severityRange.min) * payoutMultiplier)
    : 0;

  // Step 6: Generate reasoning
  const positiveSignals = signals.filter(s => s.weight > 0).map(s => s.id);
  const negativeSignals = signals.filter(s => s.weight < 0).map(s => s.id);

  let reasoning;
  if (!approved) {
    reasoning = `REJECTED: Quality ${qualityScore.toFixed(1)}/10`;
    if (!hasPositiveSignal) {
      reasoning += " — no positive quality signals detected.";
    } else {
      reasoning += " is below threshold.";
    }
    if (negativeSignals.length > 0) {
      reasoning += ` Issues: ${negativeSignals.join(", ")}.`;
    }
  } else if (needsManualReview) {
    reasoning = `NEEDS REVIEW: Quality ${qualityScore.toFixed(1)}/10, confidence ${(confidence * 100).toFixed(0)}% — insufficient data for auto-approval.`;
    if (positiveSignals.length > 0) {
      reasoning += ` Signals: ${positiveSignals.join(", ")}.`;
    }
  } else {
    reasoning = `APPROVED: Quality ${qualityScore.toFixed(1)}/10, confidence ${(confidence * 100).toFixed(0)}%.`;
    reasoning += ` Severity: ${severity.toUpperCase()}.`;
    reasoning += ` Signals: ${positiveSignals.join(", ")}.`;
    reasoning += ` Payout: $${recommendedPayout} USDC.`;
  }

  return {
    approved,
    needsManualReview,
    recommendedPayout,
    qualityScore: Math.round(qualityScore * 10) / 10,
    confidence,
    severity,
    vulnClass,
    affectedAsset,
    signals,
    reasoning,
    evaluatedAt: new Date().toISOString(),
  };
}
