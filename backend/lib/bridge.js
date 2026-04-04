// Cross-chain bridge detection and routing
// Currently flags cross-chain payouts for manual handling.
// Future: integrate Circle CCTP, Wormhole, or x402 payment facilitators.

// The primary treasury funding chain — where USDC actually lives
const DEFAULT_SOURCE_CHAIN = process.env.BOUNTYBOT_SOURCE_CHAIN || "evm";

export function detectCrossChain(recipientChain) {
  const sourceChain = DEFAULT_SOURCE_CHAIN;
  const needsBridge = recipientChain !== sourceChain;

  return {
    sourceChain,
    recipientChain,
    needsBridge,
    bridgeRoute: needsBridge ? `${sourceChain} → ${recipientChain}` : null,
  };
}

// Supported bridge routes (for future implementation)
const BRIDGE_ROUTES = {
  "evm:solana": { method: "cctp", provider: "Circle CCTP", supported: false },
  "evm:tron": { method: "manual", provider: null, supported: false },
  "evm:bitcoin": { method: "manual", provider: null, supported: false },
  "evm:cosmos": { method: "manual", provider: null, supported: false },
  "solana:evm": { method: "cctp", provider: "Circle CCTP", supported: false },
};

export function getBridgeRoute(sourceChain, recipientChain) {
  const key = `${sourceChain}:${recipientChain}`;
  return BRIDGE_ROUTES[key] || { method: "manual", provider: null, supported: false };
}

export function getBridgeInfo(recipientChain) {
  const { sourceChain, needsBridge, bridgeRoute } = detectCrossChain(recipientChain);
  if (!needsBridge) return { needsBridge: false, sourceChain, recipientChain };

  const route = getBridgeRoute(sourceChain, recipientChain);
  return {
    needsBridge: true,
    sourceChain,
    recipientChain,
    bridgeRoute,
    method: route.method,
    provider: route.provider,
    automated: route.supported,
    message: route.supported
      ? `Cross-chain payout: ${bridgeRoute} via ${route.provider}`
      : `Cross-chain payout: ${bridgeRoute} — requires manual bridging`,
  };
}
