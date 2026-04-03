#!/usr/bin/env node
// Setup script: creates OWS wallet and policy for BountyBot
import { setupTreasuryWallet, setupPolicy, setupAgentKey } from "./ows-wallet.js";

console.log("=== BountyBot OWS Setup ===\n");

// Step 1: Create wallet
const wallet = setupTreasuryWallet("bountybot-treasury");
console.log("\nWallet accounts:");
for (const acc of wallet.accounts) {
  console.log(`  ${acc.chainId}: ${acc.address}`);
}

// Step 2: Create policy
const policy = setupPolicy(150, 500);
console.log(`\nPolicy: max $150/bug, $500/day`);

// Step 3: Create agent API key
try {
  const key = setupAgentKey(wallet.id, policy.id || "bountybot-spending-limit");
  console.log(`\nAgent key: ${key.name} (${key.id})`);
  if (key.token && key.token !== "***existing***") {
    console.log(`Token created (store securely, shown once)`);
  }
} catch (err) {
  console.log(`\nAgent key note: ${err.message}`);
}

console.log("\n=== Setup complete! Run: npm start ===");
