// Layered duplicate detection using multiple fingerprints + similarity scoring
import crypto from "crypto";
import { getDb } from "../db/database.js";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Generate fingerprints for a report
export function generateFingerprints(report) {
  const fps = [];
  const normTitle = normalize(report.title);
  const normDesc = normalize(report.description);

  // 1. Exact title hash
  fps.push({ type: "title_hash", value: sha256(normTitle) });

  // 2. Description content hash (with null separator from title)
  fps.push({ type: "desc_hash", value: sha256(`${normTitle}\0${normDesc}`) });

  // 3. Vulnerability class (if detected)
  const vulnClass = detectVulnClass(report.title + " " + report.description);
  if (vulnClass) {
    fps.push({ type: "vuln_type", value: vulnClass });
  }

  // 4. Affected asset/endpoint
  const asset = extractAffectedAsset(report.title + " " + report.description);
  if (asset) {
    fps.push({ type: "asset", value: sha256(asset) });
  }

  // 5. Combined: vuln_type + asset (strong duplicate signal)
  if (vulnClass && asset) {
    fps.push({ type: "combined", value: sha256(`${vulnClass}\0${asset}`) });
  }

  return fps;
}

// Store fingerprints in DB
export function storeFingerprints(reportId, fingerprints) {
  const db = getDb();
  const stmt = db.prepare("INSERT INTO fingerprints (report_id, type, value, created_at) VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const fp of fingerprints) {
    stmt.run(reportId, fp.type, fp.value, now);
  }
}

// Find potential duplicates — accepts object: { fingerprints, excludeReportId, title, programId }
export function findDuplicates({ fingerprints, excludeReportId = null, title = null, programId = null }) {
  const db = getDb();
  const matchWeights = {
    title_hash: 0.4,
    desc_hash: 0.5,
    vuln_type: 0.1,
    asset: 0.2,
    combined: 0.6,
  };

  const candidateScores = new Map(); // reportId -> { score, matches }

  // Step 1: Fingerprint-based matching (scoped to program if provided)
  for (const fp of fingerprints) {
    let query, params;
    if (programId) {
      query = "SELECT DISTINCT f.report_id FROM fingerprints f JOIN reports r ON f.report_id = r.id WHERE f.type = ? AND f.value = ? AND r.program_id = ?";
      params = [fp.type, fp.value, programId];
    } else {
      query = "SELECT DISTINCT report_id FROM fingerprints WHERE type = ? AND value = ?";
      params = [fp.type, fp.value];
    }
    if (excludeReportId) {
      query += programId ? " AND f.report_id != ?" : " AND report_id != ?";
      params.push(excludeReportId);
    }
    const matches = db.prepare(query).all(...params);
    const weight = matchWeights[fp.type] || 0.1;

    for (const match of matches) {
      const rid = match.report_id;
      const existing = candidateScores.get(rid) || { score: 0, matches: [] };
      existing.score += weight;
      existing.matches.push(fp.type);
      candidateScores.set(rid, existing);
    }
  }

  // Step 2: Fuzzy title matching (scoped to program, last 30 days)
  if (title && programId) {
    let recentQuery = "SELECT id, title FROM reports WHERE program_id = ? AND created_at > date('now', '-30 days')";
    const recentParams = [programId];
    if (excludeReportId) {
      recentQuery += " AND id != ?";
      recentParams.push(excludeReportId);
    }
    const recentReports = db.prepare(recentQuery).all(...recentParams);

    for (const r of recentReports) {
      const sim = titleSimilarity(title, r.title);
      if (sim < 0.5) continue;
      const existing = candidateScores.get(r.id) || { score: 0, matches: [] };
      // Tiered weight based on similarity strength
      const weight = sim >= 0.9 ? 0.55 : sim >= 0.8 ? 0.45 : 0.2;
      existing.score += weight;
      existing.matches.push("fuzzy_title");
      candidateScores.set(r.id, existing);
    }
  }

  if (candidateScores.size === 0) {
    return { isDuplicate: false, isProbable: false, score: 0, matches: [], duplicateOf: null };
  }

  // Find best match
  let bestId = null;
  let bestData = { score: 0, matches: [] };
  for (const [reportId, data] of candidateScores) {
    if (data.score > bestData.score) {
      bestId = reportId;
      bestData = data;
    }
  }

  // Normalize score to 0-1 (max possible is ~2.15 with all fingerprints + fuzzy)
  const normalizedScore = Math.min(1, bestData.score / 1.2);

  return {
    isDuplicate: normalizedScore >= 0.8,
    isProbable: normalizedScore >= 0.4,
    score: Math.round(normalizedScore * 100) / 100,
    matches: bestData.matches,
    duplicateOf: bestId,
  };
}

// Simple trigram similarity for fuzzy title matching
export function titleSimilarity(a, b) {
  const trigramsA = trigrams(normalize(a));
  const trigramsB = trigrams(normalize(b));
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0;
  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }
  return intersection / Math.max(trigramsA.size, trigramsB.size);
}

function trigrams(str) {
  const set = new Set();
  for (let i = 0; i <= str.length - 3; i++) {
    set.add(str.slice(i, i + 3));
  }
  return set;
}

// Detect vulnerability class from text
const VULN_PATTERNS = [
  { pattern: /\bsql\s*injection\b/i, type: "sqli" },
  { pattern: /\bxss\b|\bcross.?site\s*scripting\b/i, type: "xss" },
  { pattern: /\bcsrf\b|\bcross.?site\s*request\b/i, type: "csrf" },
  { pattern: /\bssrf\b|\bserver.?side\s*request\b/i, type: "ssrf" },
  { pattern: /\brce\b|\bremote\s*code\s*execution\b/i, type: "rce" },
  { pattern: /\bidor\b|\binsecure\s*direct\s*object\b/i, type: "idor" },
  { pattern: /\bauth(?:entication|orization)?\s*bypass\b/i, type: "auth_bypass" },
  { pattern: /\bpath\s*traversal\b|\bdirectory\s*traversal\b/i, type: "path_traversal" },
  { pattern: /\bopen\s*redirect\b/i, type: "open_redirect" },
  { pattern: /\bbuffer\s*overflow\b/i, type: "buffer_overflow" },
  { pattern: /\bprivilege\s*escalation\b/i, type: "privesc" },
  { pattern: /\binfo(?:rmation)?\s*(?:leak|disclosure|exposure)\b/i, type: "info_disclosure" },
];

export function detectVulnClass(text) {
  for (const { pattern, type } of VULN_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

// Extract affected asset/endpoint from text
const ASSET_PATTERNS = [
  /(?:\/api\/[\w\-\/]+)/i,                    // API paths
  /(?:https?:\/\/[^\s"'<>]+)/i,               // URLs
  /(?:(?:GET|POST|PUT|DELETE|PATCH)\s+\/[\w\-\/]+)/i, // HTTP method + path
];

export function extractAffectedAsset(text) {
  for (const pattern of ASSET_PATTERNS) {
    const match = text.match(pattern);
    if (match) return normalize(match[0]);
  }
  return null;
}
