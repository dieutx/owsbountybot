import crypto from "crypto";
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

export const ALLOWED_SIGNING_CHAINS = Object.freeze({
  evm: "eip155:1",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  bitcoin: "bip122:000000000019d6689c085ae165831e93",
  tron: "tron:mainnet",
  cosmos: "cosmos:cosmoshub-4",
});

function getVaultPath() {
  return process.env.OWS_VAULT_PATH || undefined;
}

function buildPolicyId(maxPerTx, dailyLimit) {
  return `bountybot-chain-guard-${maxPerTx}-${dailyLimit}`;
}

export function normalizeChain(chain) {
  if (typeof chain !== "string") {
    return null;
  }

  const normalized = chain.trim().toLowerCase();
  const aliasMap = {
    evm: "evm",
    "eip155:1": "evm",
    ethereum: "evm",
    eth: "evm",
    base: "evm",
    polygon: "evm",
    solana: "solana",
    sol: "solana",
    [ALLOWED_SIGNING_CHAINS.solana.toLowerCase()]: "solana",
    bitcoin: "bitcoin",
    btc: "bitcoin",
    tron: "tron",
    trx: "tron",
    cosmos: "cosmos",
    atom: "cosmos",
  };

  return aliasMap[normalized] || null;
}

// Auto-detect chain from wallet address format
export function detectChainFromAddress(address) {
  if (!address || typeof address !== "string") return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "evm";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return "tron";       // Tron before Solana (Tron is subset of Solana regex)
  if (/^(bc1[a-zA-HJ-NP-Z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address)) return "bitcoin";
  if (/^cosmos1[a-z0-9]{38}$/.test(address)) return "cosmos";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "solana";   // Solana last (catch-all for base58)
  return null;
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
      allowedSigningChains: Object.keys(ALLOWED_SIGNING_CHAINS),
    },
    rules: [
      { type: "allowed_chains", chain_ids: Object.values(ALLOWED_SIGNING_CHAINS) },
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
    const matchingKey = existing.find((key) => (
      key.wallet_ids?.includes(walletId) &&
      key.policy_ids?.includes(policyId)
    ));

    if (matchingKey) {
      console.log(`[OWS] Agent key already exists for wallet/policy`);
      return { token: "***existing***", id: matchingKey.id, name: matchingKey.name };
    }
  } catch {
    // no keys yet
  }

  const key = createApiKey(
    `bountybot-agent-${policyId}`,
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
    authorizationId: `auth_${crypto.randomUUID()}`,
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
