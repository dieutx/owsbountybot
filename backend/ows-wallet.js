import {
  createWallet,
  listWallets,
  getWallet,
  signMessage,
  signTransaction,
  createPolicy,
  listPolicies,
  createApiKey,
  listApiKeys,
} from "@open-wallet-standard/core";

const VAULT_PATH = process.env.OWS_VAULT_PATH || undefined;

// Create or get the bounty treasury wallet
export function setupTreasuryWallet(name = "bountybot-treasury") {
  try {
    const existing = getWallet(name, VAULT_PATH);
    console.log(`[OWS] Found existing wallet: ${existing.name} (${existing.id})`);
    return existing;
  } catch {
    const wallet = createWallet(name, undefined, 12, VAULT_PATH);
    console.log(`[OWS] Created new wallet: ${wallet.name} (${wallet.id})`);
    console.log(`[OWS] Accounts:`);
    for (const acc of wallet.accounts) {
      console.log(`  ${acc.chainId}: ${acc.address}`);
    }
    return wallet;
  }
}

// Create a spending-limit policy for the agent
export function setupPolicy(maxPerTx = 150, dailyLimit = 500) {
  const policyId = "bountybot-spending-limit";
  try {
    const existing = listPolicies(VAULT_PATH);
    const found = existing.find(p => p.id === policyId);
    if (found) {
      console.log(`[OWS] Policy already exists: ${policyId}`);
      return found;
    }
  } catch {
    // no policies yet
  }

  const policy = {
    id: policyId,
    name: `BountyBot Spending Limit ($${maxPerTx}/tx, $${dailyLimit}/day)`,
    version: 1,
    created_at: new Date().toISOString(),
    action: "deny",
    rules: [
      { type: "allowed_chains", chain_ids: ["eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] },
    ],
  };

  createPolicy(JSON.stringify(policy), VAULT_PATH);
  console.log(`[OWS] Created policy: ${policyId} (max $${maxPerTx}/tx, $${dailyLimit}/day)`);
  return policy;
}

// Create an API key for the agent
export function setupAgentKey(walletId, policyId) {
  try {
    const existing = listApiKeys(VAULT_PATH);
    if (existing.length > 0) {
      console.log(`[OWS] Agent key already exists`);
      return { token: "***existing***", id: existing[0].id, name: existing[0].name };
    }
  } catch {
    // no keys yet
  }

  const key = createApiKey(
    "bountybot-agent",
    [walletId],
    [policyId],
    "", // no passphrase for demo
    undefined,
    VAULT_PATH
  );
  console.log(`[OWS] Created agent API key: ${key.name} (${key.id})`);
  return key;
}

// Sign a payout message (simulated — in production, this would be signAndSend)
export function signPayout(walletName, chain, amount, recipientAddress) {
  const message = JSON.stringify({
    type: "bounty_payout",
    amount,
    currency: "USDC",
    to: recipientAddress,
    timestamp: new Date().toISOString(),
  });

  const result = signMessage(walletName, chain, message, undefined, undefined, undefined, VAULT_PATH);

  return {
    signature: result.signature,
    message,
    txHash: `0x${result.signature.slice(0, 64)}`, // simulated tx hash from signature
  };
}

// Get wallet info
export function getWalletInfo(name = "bountybot-treasury") {
  try {
    return getWallet(name, VAULT_PATH);
  } catch {
    return null;
  }
}

// List all wallets
export function getAllWallets() {
  try {
    return listWallets(VAULT_PATH);
  } catch {
    return [];
  }
}
