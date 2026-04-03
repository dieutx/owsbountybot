// In-memory store for bounty programs, reports, and transactions
const store = {
  program: null,        // { name, description, wallet, maxPerBug, dailyLimit, totalPaid }
  reports: [],          // { id, title, severity, description, reporterWallet, status, payout, reasoning, txHash, createdAt }
  transactions: [],     // { id, reportId, amount, to, txHash, chain, timestamp }
  dailySpent: 0,
  lastResetDate: new Date().toDateString(),
};

export function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (store.lastResetDate !== today) {
    store.dailySpent = 0;
    store.lastResetDate = today;
  }
}

export default store;
