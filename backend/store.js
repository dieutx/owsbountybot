import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
    return {
      program: normalizeProgram(parsed.program),
      reports: Array.isArray(parsed.reports) ? parsed.reports : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      dailySpent: Number.isFinite(parsed.dailySpent) ? parsed.dailySpent : 0,
      lastResetDate: typeof parsed.lastResetDate === "string" ? parsed.lastResetDate : defaults.lastResetDate,
      seenReportHashes: Array.isArray(parsed.seenReportHashes) ? parsed.seenReportHashes : [],
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

export function syncStore() {
  const nextPath = getStorePath();
  if (nextPath !== activeStorePath) {
    activeStorePath = nextPath;
    assignStoreState(loadStore(activeStorePath));
  }
}

export function saveStore() {
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
  saveStore();
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
  return store.seenReportHashes.includes(hash);
}

export function rememberReportHash(hash) {
  syncStore();
  if (!hasSeenReportHash(hash)) {
    store.seenReportHashes.push(hash);
    saveStore();
  }
}

export default store;
