import {
  createWallet,
  listWallets,
  getWallet,
  signMessage,
  createPolicy,
  listPolicies,
  createApiKey,
  listApiKeys,
} from "@open-wallet-standard/core";

function getVaultPath() {
  return process.env.OWS_VAULT_PATH || undefined;
}

function buildPolicyId(maxPerTx, dailyLimit) {
  return `bountybot-chain-guard-${maxPerTx}-${dailyLimit}`;
}

// Create or get the bounty treasury wallet
export function setupTreasuryWallet(name = "bountybot-treasury") {
  const vaultPath = getVaultPath();
  try {
    const existing = getWallet(name, vaultPath);
    console.log(`[OWS] Found existing wallet: ${existing.name} (${existing.id})`);
    return existing;
  } catch {
    const wallet = createWallet(name, undefined, 12, vaultPath);
    console.log(`[OWS] Created new wallet: ${wallet.name} (${wallet.id})`);
    console.log(`[OWS] Accounts:`);
    for (const acc of wallet.accounts) {
      console.log(`  ${acc.chainId}: ${acc.address}`);
    }
    return wallet;
  }
}

// Create a chain-guard policy for the agent. Numeric payout caps are enforced by the app.
export function setupPolicy(maxPerTx = 150, dailyLimit = 500) {
  const policyId = buildPolicyId(maxPerTx, dailyLimit);
  const vaultPath = getVaultPath();
  try {
    const existing = listPolicies(vaultPath);
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
    name: `BountyBot Chain Guard ($${maxPerTx}/bug, $${dailyLimit}/day app caps)`,
    version: 1,
    created_at: new Date().toISOString(),
    action: "deny",
    metadata: {
      appEnforcedMaxPerBug: maxPerTx,
      appEnforcedDailyLimit: dailyLimit,
    },
    rules: [
      { type: "allowed_chains", chain_ids: ["eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] },
    ],
  };

  createPolicy(JSON.stringify(policy), vaultPath);
  console.log(`[OWS] Created policy: ${policyId} (app caps $${maxPerTx}/bug, $${dailyLimit}/day)`);
  return policy;
}

// Create an API key for the agent
export function setupAgentKey(walletId, policyId) {
  const vaultPath = getVaultPath();
  try {
    const existing = listApiKeys(vaultPath);
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
    vaultPath
  );
  console.log(`[OWS] Created agent API key: ${key.name} (${key.id})`);
  return key;
}

// The demo authorizes payouts by signing a message. It does not broadcast a real transfer.
export function authorizePayout(walletName, chain, amount, recipientAddress) {
  const vaultPath = getVaultPath();
  const message = JSON.stringify({
    type: "bounty_payout",
    amount,
    currency: "USDC",
    to: recipientAddress,
    timestamp: new Date().toISOString(),
  });

  const result = signMessage(walletName, chain, message, undefined, undefined, undefined, vaultPath);

  return {
    status: "signed",
    signature: result.signature,
    message,
    authorizationId: `sig_${result.signature.slice(0, 24)}`,
    txHash: null,
  };
}

// Get wallet info
export function getWalletInfo(name = "bountybot-treasury") {
  const vaultPath = getVaultPath();
  try {
    return getWallet(name, vaultPath);
  } catch {
    return null;
  }
}

// List all wallets
export function getAllWallets() {
  const vaultPath = getVaultPath();
  try {
    return listWallets(vaultPath);
  } catch {
    return [];
  }
}
