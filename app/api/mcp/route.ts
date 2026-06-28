import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { createPublicClient, http, defineChain, formatUnits, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Chain ──
const baseSepolia = defineChain({
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://basescan.org" } },
});

const client = createPublicClient({ chain: baseSepolia, transport: http() });

// ── Addresses ──
const ADDR = {
  vault: "0x00325d9da832b38179ed2f0dabd4062d93e325a7" as `0x${string}`,
  credit: "0x019540E33a0292a9DDE36bD9Ef11774d5A1Ce6FC" as `0x${string}`,
  router: "0xd0c64f997ca9aa427f8834578bd7f0313f868e83" as `0x${string}`,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  strategy: "0x43626D6162Ccb12328B989BB228DaD2941F2F12a" as `0x${string}`,
  allocator: "0x7Fd5d7b49694858FCf143E0039e83cDB0196DD7A" as `0x${string}`,
  registry: "0x79E79629DB86CFb8feF9594621882b065EBC80A7" as `0x${string}`,
};

// ── ABIs ──
const VAULT_ABI = [
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalSupply", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "exchangeRate", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "depositCap", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "remainingCapacity", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "reserveBalance", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "deployedBalance", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "paused", type: "function", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "balance", type: "function", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "previewDeposit", type: "function", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "asset", type: "function", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { name: "maxDeposit", type: "function", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "deposit", type: "function", inputs: [{ name: "amount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { name: "withdraw", type: "function", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
] as const;

const CREDIT_ABI = [
  { name: "lendingPool", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalBorrowed", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "baseRateBps", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "collateralRatios", type: "function", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "rateDiscounts", type: "function", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "loanCount", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalOwed", type: "function", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
] as const;

// ── Helpers ──
const fmtUSDC = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const fmtRate = (v: bigint) => (Number(v) / 1e18).toFixed(6);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const error = (text: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${text}` }], isError: true as const });

// Rate limiting for write tools
const writeRateLimit = new Map<string, number>();
const WRITE_COOLDOWN_MS = 60_000;
function checkRateLimit(key: string): string | null {
  const last = writeRateLimit.get(key) || 0;
  const remaining = WRITE_COOLDOWN_MS - (Date.now() - last);
  if (remaining > 0) return `Rate limited. Try again in ${Math.ceil(remaining / 1000)}s.`;
  writeRateLimit.set(key, Date.now());
  return null;
}

// ── Handler ──
const handler = createMcpHandler(
  (server) => {
    // ═══ READ TOOLS ═══

    server.tool("arcis_vault_status", "Get vault TVL, exchange rate, supply, deposit cap, reserve/deployed split, and pause state", {}, async () => {
      try {
        const [totalAssets, totalSupply, rate, cap, remaining, reserve, deployed, paused] = await Promise.all([
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "totalAssets" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "totalSupply" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "exchangeRate" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "depositCap" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "remainingCapacity" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "reserveBalance" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "deployedBalance" }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "paused" }),
        ]);
        const utilPct = cap > 0n ? (Number(totalAssets * 10000n / cap) / 100).toFixed(2) : "0";
        return ok(`# Arcis Vault Status\n- TVL: $${fmtUSDC(totalAssets)} USDC\n- raUSDC Supply: ${fmtUSDC(totalSupply)} shares\n- Exchange Rate: ${fmtRate(rate)} USDC/raUSDC\n- Deposit Cap: $${fmtUSDC(cap)} USDC\n- Remaining Capacity: $${fmtUSDC(remaining)} USDC\n- Utilization: ${utilPct}%\n- Reserve: $${fmtUSDC(reserve)} | Deployed: $${fmtUSDC(deployed)}\n- Paused: ${paused}`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_vault_balance", "Check an agent's vault position", { agent_address: z.string().describe("Agent's wallet address (0x...)") }, async ({ agent_address }) => {
      try {
        const addr = agent_address as `0x${string}`;
        const [shares, value, usdcBal] = await Promise.all([
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balanceOf", args: [addr] }),
          client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balance", args: [addr] }),
          client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] }),
        ]);
        return ok(`# Agent Position: ${agent_address}\n- raUSDC Shares: ${fmtUSDC(shares)}\n- Position Value: $${fmtUSDC(value)} USDC\n- USDC Wallet: $${fmtUSDC(usdcBal)}`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_preview_deposit", "Preview shares for a deposit amount", { amount: z.number().describe("USDC amount to deposit") }, async ({ amount }) => {
      try {
        const raw = BigInt(Math.floor(amount * 1e6));
        const shares = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "previewDeposit", args: [raw] });
        return ok(`Depositing $${amount} USDC would mint ${fmtUSDC(shares)} raUSDC shares.`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_credit_status", "Get lending pool status", {}, async () => {
      try {
        const [pool, borrowed, baseRate, loanCount] = await Promise.all([
          client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "lendingPool" }),
          client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalBorrowed" }),
          client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "baseRateBps" }),
          client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "loanCount" }),
        ]);
        const total = pool + borrowed;
        const util = total > 0n ? (Number(borrowed * 10000n / total) / 100).toFixed(2) : "0";
        return ok(`# Agent Credit Status\n- Lending Pool: $${fmtUSDC(pool)} USDC\n- Total Borrowed: $${fmtUSDC(borrowed)} USDC\n- Utilization: ${util}%\n- Base Rate: ${Number(baseRate) / 100}% APR\n- Active Loans: ${loanCount}`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_credit_tiers", "Get ERC-8004 reputation tier table", {}, async () => {
      try {
        const tiers = [];
        const names = ["Unverified", "Basic", "Established", "Trusted", "Elite"];
        for (let i = 0; i < 5; i++) {
          const [ratio, discount] = await Promise.all([
            client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "collateralRatios", args: [BigInt(i)] }),
            client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "rateDiscounts", args: [BigInt(i)] }),
          ]);
          tiers.push(`| ${i} | ${names[i]} | ${Number(ratio) / 100}% | -${Number(discount) / 100}% |`);
        }
        return ok(`# Reputation Tiers\n| Tier | Name | Collateral Ratio | Rate Discount |\n|---|---|---|---|\n${tiers.join("\n")}`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_credit_health", "Check loan health for an agent", { loan_id: z.number().describe("Loan ID to check") }, async ({ loan_id }) => {
      try {
        const owed = await client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalOwed", args: [BigInt(loan_id)] });
        return ok(`# Loan #${loan_id}\n- Total Owed: $${fmtUSDC(owed)} USDC`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_contracts", "Get all deployed contract addresses", {}, async () => {
      return ok(`# Arcis Protocol Contracts (Base)\n- ArcisVault (raUSDC): ${ADDR.vault}\n- AgentCredit: ${ADDR.credit}\n- ATIRouter: ${ADDR.router}\n- MockUSDC: ${ADDR.usdc}\n- MockStrategy: ${ADDR.strategy}\n- StrategyAllocator: ${ADDR.allocator}\n- MockIdentityRegistry: ${ADDR.registry}\n\nExplorer: https://basescan.org`);
    });

    // ═══ WRITE TOOLS ═══

    server.tool("arcis_deposit", "Deposit USDC into the Arcis vault", {
      amount: z.number().describe("USDC amount to deposit"),
      private_key: z.string().describe("Agent's private key (0x...)"),
    }, async ({ amount, private_key }) => {
      try {
        const rateErr = checkRateLimit(private_key.slice(0, 10));
        if (rateErr) return error(rateErr);
        const amountRaw = BigInt(Math.floor(amount * 1e6));
        const account = privateKeyToAccount(private_key as `0x${string}`);
        const wallet = createWalletClient({ chain: baseSepolia, transport: http(), account });
        const usdcBal = await client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        if (usdcBal < amountRaw) return error(`Insufficient USDC. Balance: $${fmtUSDC(usdcBal)}, needed: $${amount}`);
        await wallet.writeContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "approve", args: [ADDR.vault, amountRaw], chain: baseSepolia });
        const hash = await wallet.writeContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "deposit", args: [amountRaw], chain: baseSepolia });
        return ok(`Deposited $${amount} USDC into Arcis Vault.\nTx: https://basescan.org/tx/${hash}`);
      } catch (e: any) { return error(e.message); }
    });

    server.tool("arcis_withdraw", "Withdraw from the Arcis vault", {
      shares: z.number().optional().describe("raUSDC shares to redeem"),
      private_key: z.string().describe("Agent's private key (0x...)"),
      withdraw_all: z.boolean().optional().describe("Set true to withdraw entire balance"),
    }, async ({ shares, private_key, withdraw_all }) => {
      try {
        const rateErr = checkRateLimit(private_key.slice(0, 10));
        if (rateErr) return error(rateErr);
        const account = privateKeyToAccount(private_key as `0x${string}`);
        const wallet = createWalletClient({ chain: baseSepolia, transport: http(), account });
        let sharesToRedeem: bigint;
        if (withdraw_all) {
          sharesToRedeem = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balanceOf", args: [account.address] });
          if (sharesToRedeem === 0n) return error("No shares to withdraw.");
        } else {
          if (!shares) return error("Specify shares amount or set withdraw_all: true");
          sharesToRedeem = BigInt(Math.floor(shares * 1e6));
        }
        const hash = await wallet.writeContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "withdraw", args: [sharesToRedeem], chain: baseSepolia });
        return ok(`Withdrew ${fmtUSDC(sharesToRedeem)} raUSDC shares.\nTx: https://basescan.org/tx/${hash}`);
      } catch (e: any) { return error(e.message); }
    });
  },
  {
    name: "arcis-protocol",
    version: "0.1.3",
  },
  {
    basePath: "/api",
    maxDuration: 30,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
