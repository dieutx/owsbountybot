import { existsSync, mkdirSync, readFileSync, writeFile, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getStorePath() {
  return process.env.BOUNTYBOT_STATE_PATH || join(__dirname, "../data/state.json");
}

function createDefaultStore() {
  return {
    program: null,
    reports: [],
    transactions: [],
    dailySpent: 0,
    lastResetDate: new Date().toDateString(),
    seenReportHashes: [],
  };
}

// In-memory Set for O(1) duplicate lookups (M-2)
let seenHashSet = new Set();

function normalizeProgram(program) {
  if (!program || typeof program !== "object") {
    return null;
  }

  const usesNewTotals = Object.prototype.hasOwnProperty.call(program, "totalAuthorized");
  const legacyAuthorizedTotal = usesNewTotals
    ? (Number.isFinite(program.totalAuthorized) ? program.totalAuthorized : 0)
    : (Number.isFinite(program.totalPaid) ? program.totalPaid : 0);

  return {
    ...program,
    totalAuthorized: legacyAuthorizedTotal,
    totalPaid: usesNewTotals
      ? (Number.isFinite(program.totalPaid) ? program.totalPaid : 0)
      : 0,
  };
}

function loadStore(storePath = getStorePath()) {
  const defaults = createDefaultStore();

  if (!existsSync(storePath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    const hashes = Array.isArray(parsed.seenReportHashes) ? parsed.seenReportHashes : [];
    seenHashSet = new Set(hashes);
    return {
      program: normalizeProgram(parsed.program),
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      dailySpent: Number.isFinite(parsed.dailySpent) ? parsed.dailySpent : 0,
      lastResetDate: typeof parsed.lastResetDate === "string" ? parsed.lastResetDate : defaults.lastResetDate,
      seenReportHashes: hashes,
    };
  } catch (err) {
    console.warn(`[store] Failed to read persisted state at ${storePath}: ${err.message}`);
    return defaults;
  }
}

function assignStoreState(nextState) {
  store.program = nextState.program;
  store.reports = nextState.reports;
  store.transactions = nextState.transactions;
  store.dailySpent = nextState.dailySpent;
  store.lastResetDate = nextState.lastResetDate;
  store.seenReportHashes = nextState.seenReportHashes;
}

const store = createDefaultStore();
let activeStorePath = getStorePath();
assignStoreState(loadStore(activeStorePath));

// Debounced async write to avoid blocking event loop (M-3)
let saveTimer = null;
let savePending = false;

function scheduleSave() {
  if (saveTimer) return;
  savePending = true;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePending = false;
    mkdirSync(dirname(activeStorePath), { recursive: true });
    const data = JSON.stringify(store, null, 2);
    writeFile(activeStorePath, data, (err) => {
      if (err) console.error("[store] Async write failed:", err.message);
    });
  }, 50);
}

export function syncStore() {
  const nextPath = getStorePath();
  if (nextPath !== activeStorePath) {
    activeStorePath = nextPath;
    assignStoreState(loadStore(activeStorePath));
  }
}

export function saveStore() {
  syncStore();
  scheduleSave();
}

// Synchronous save for critical operations (program init, shutdown)
export function saveStoreSync() {
  syncStore();
  mkdirSync(dirname(activeStorePath), { recursive: true });
  writeFileSync(activeStorePath, JSON.stringify(store, null, 2));
}

export function initializeProgram(program) {
  syncStore();
  store.program = {
    ...program,
    totalAuthorized: Number.isFinite(program.totalAuthorized) ? program.totalAuthorized : 0,
    totalPaid: Number.isFinite(program.totalPaid) ? program.totalPaid : 0,
  };
  store.reports = [];
  store.transactions = [];
  store.dailySpent = 0;
  store.lastResetDate = new Date().toDateString();
  store.seenReportHashes = [];
  seenHashSet = new Set();
  saveStoreSync();
}

export function resetDailyIfNeeded() {
  syncStore();
  const today = new Date().toDateString();
  if (store.lastResetDate !== today) {
    store.dailySpent = 0;
    store.lastResetDate = today;
    saveStore();
  }
}

export function hasSeenReportHash(hash) {
  syncStore();
  return seenHashSet.has(hash);
}

export function rememberReportHash(hash) {
  syncStore();
  if (!seenHashSet.has(hash)) {
    seenHashSet.add(hash);
    store.seenReportHashes.push(hash);
    saveStore();
  }
}

export default store;
