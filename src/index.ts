import { MCPServer, text, object, error, markdown } from "mcp-use/server";
import { z } from "zod";
import { createPublicClient, createWalletClient, http, defineChain, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Chain ──
const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://base-sepolia.blockscout.com" } },
});

// ── Addresses ──
const ADDR = {
  vault: "0xa8eF658E125C7f6D7aFa9B6b8035b66b32CBE98d" as Address,
  credit: "0x019540E33a0292a9DDE36bD9Ef11774d5A1Ce6FC" as Address,
  router: "0x0281e7D37683c585325004F84e0b94170c78d5B4" as Address,
  usdc: "0x29440A12f15fe6bDf5F624f4eeEB298CCb782f05" as Address,
  allocator: "0x9f101e1159AA530dC5Cb104decB32aBA1eAF2617" as Address,
  strategy: "0x9d6FB397224141FD323096e95667d3Ae5D9FF9cC" as Address,
  identity: "0x79E79629DB86CFb8feF9594621882b065EBC80A7" as Address,
};

// ── ABIs ──
const VAULT_ABI = [
  { name: "deposit", type: "function", inputs: [{ name: "amount", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { name: "withdraw", type: "function", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "nonpayable" },
  { name: "balance", type: "function", inputs: [{ name: "agent", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalSupply", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "exchangeRate", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "depositCap", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "remainingCapacity", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "reserveBalance", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "deployedBalance", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "paused", type: "function", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { name: "previewDeposit", type: "function", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "previewWithdraw", type: "function", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const CREDIT_ABI = [
  { name: "lendingPool", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalBorrowed", type: "function", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "collateralRatios", type: "function", inputs: [{ name: "tier", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "totalOwed", type: "function", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "isHealthy", type: "function", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
] as const;

const ERC20_ABI = [
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "allowance", type: "function", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

// ── Helpers ──
const client = createPublicClient({ chain: baseSepolia, transport: http() });
const fmtUSDC = (raw: bigint) => formatUnits(raw, 6);
const fmtRate = (raw: bigint) => { const n = Number(raw) / 1e18; return n > 1000 || n < 0.0001 ? "1.000000" : n.toFixed(6); };

// ═══════════════════════════════════════════════════
//  SERVER
// ═══════════════════════════════════════════════════

const server = new MCPServer({
  name: "arcis-protocol",
  title: "Arcis Protocol",
  description: "Financial infrastructure for autonomous AI agents — yield vaults, credit, and bonds on Base",
  version: "0.1.0",
});

// ═══════════════════════════════════════════════════
//  READ TOOLS
// ═══════════════════════════════════════════════════

server.tool(
  {
    name: "arcis_vault_status",
    description: "Get the current vault status: TVL, exchange rate, raUSDC supply, deposit cap, reserve/deployed split, and pause state. No parameters needed.",
    schema: z.object({}),
  },
  async () => {
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
      const resPct = totalAssets > 0n ? (Number(reserve * 10000n / totalAssets) / 100).toFixed(1) : "0";

      return object({
        network: "Base Sepolia (84532)",
        contract: ADDR.vault,
        status: paused ? "PAUSED" : "ACTIVE",
        tvl_usdc: fmtUSDC(totalAssets),
        rausdc_supply: fmtUSDC(totalSupply),
        exchange_rate: totalSupply > 0n ? fmtRate(rate) : "1.000000",
        reserve_usdc: fmtUSDC(reserve),
        reserve_pct: resPct + "%",
        deployed_usdc: fmtUSDC(deployed),
        deposit_cap_usdc: cap > 0n ? fmtUSDC(cap) : "No cap set",
        remaining_capacity: cap > 0n ? fmtUSDC(remaining) : "Unlimited",
        utilization: utilPct + "%",
        explorer: `https://base-sepolia.blockscout.com/address/${ADDR.vault}`,
      });
    } catch (e: any) {
      return error("Failed to fetch vault status: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_vault_balance",
    description: "Check an agent's vault position: raUSDC shares held, position value in USDC, and USDC wallet balance.",
    schema: z.object({
      address: z.string().describe("The agent's Ethereum address (0x...)"),
    }),
  },
  async ({ address }) => {
    try {
      const agent = address as Address;
      const [shares, value, usdcBal] = await Promise.all([
        client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balanceOf", args: [agent] }),
        client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balance", args: [agent] }),
        client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [agent] }),
      ]);

      return object({
        agent: address,
        rausdc_shares: fmtUSDC(shares),
        position_value_usdc: fmtUSDC(value),
        usdc_wallet_balance: fmtUSDC(usdcBal),
      });
    } catch (e: any) {
      return error("Failed to fetch balance: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_preview_deposit",
    description: "Preview how many raUSDC shares a given USDC deposit would yield, without executing the transaction.",
    schema: z.object({
      amount: z.number().positive().describe("Amount of USDC to deposit (e.g. 1000 for $1,000)"),
    }),
  },
  async ({ amount }) => {
    try {
      const raw = BigInt(Math.floor(amount * 1e6));
      const shares = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "previewDeposit", args: [raw] });
      return object({
        deposit_usdc: amount.toString(),
        shares_received: fmtUSDC(shares),
        exchange_rate: (amount * 1e6 / Number(shares)).toFixed(6),
      });
    } catch (e: any) {
      return error("Preview failed: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_credit_status",
    description: "Get the credit module status: lending pool size, total borrowed, and utilization rate.",
    schema: z.object({}),
  },
  async () => {
    try {
      const [pool, borrowed] = await Promise.all([
        client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "lendingPool" }),
        client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalBorrowed" }),
      ]);
      const total = pool + borrowed;
      const utilPct = total > 0n ? (Number(borrowed * 10000n / total) / 100).toFixed(1) : "0";

      return object({
        contract: ADDR.credit,
        lending_pool_usdc: fmtUSDC(pool),
        total_borrowed_usdc: fmtUSDC(borrowed),
        utilization: utilPct + "%",
      });
    } catch (e: any) {
      return error("Failed to fetch credit status: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_credit_tiers",
    description: "List all 5 ERC-8004 reputation tiers with their collateral ratios and rate discounts.",
    schema: z.object({}),
  },
  async () => {
    try {
      const labels = ["No Identity", "Novice (1-25)", "Active (26-50)", "Established (51-75)", "Elite (76-100)"];
      const discounts = [0, 100, 200, 350, 500];

      const ratios = await Promise.all(
        [0, 1, 2, 3, 4].map(i =>
          client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "collateralRatios", args: [BigInt(i)] })
        )
      );

      return object({
        tiers: ratios.map((r, i) => ({
          tier: i,
          label: labels[i],
          collateral_ratio: (Number(r) / 100).toFixed(1) + "%",
          rate_discount_bps: discounts[i],
        })),
      });
    } catch (e: any) {
      return error("Failed to fetch tiers: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_credit_health",
    description: "Check whether a specific loan is healthy (sufficiently collateralized) and how much is owed.",
    schema: z.object({
      loan_id: z.number().int().positive().describe("The loan ID to check"),
    }),
  },
  async ({ loan_id }) => {
    try {
      const [healthy, owed] = await Promise.all([
        client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "isHealthy", args: [BigInt(loan_id)] }),
        client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalOwed", args: [BigInt(loan_id)] }),
      ]);
      return object({
        loan_id,
        healthy,
        total_owed_usdc: fmtUSDC(owed),
        status: healthy ? "HEALTHY" : "UNDERCOLLATERALIZED",
      });
    } catch (e: any) {
      return error("Failed to check loan health: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_contracts",
    description: "List all deployed Arcis Protocol contract addresses on Base Sepolia with their roles.",
    schema: z.object({}),
  },
  async () => {
    return object({
      network: "Base Sepolia (84532)",
      explorer: "https://base-sepolia.blockscout.com",
      contracts: {
        ArcisVault: { address: ADDR.vault, role: "ERC-4626 yield vault (raUSDC)" },
        AgentCredit: { address: ADDR.credit, role: "ERC-8004 identity-aware lending" },
        ATIRouter: { address: ADDR.router, role: "Multi-vault entry point" },
        StrategyAllocator: { address: ADDR.allocator, role: "Yield strategy weights" },
        MockStrategy: { address: ADDR.strategy, role: "Testnet yield strategy" },
        MockUSDC: { address: ADDR.usdc, role: "Testnet USDC" },
        MockIdentityRegistry: { address: ADDR.identity, role: "ERC-8004 test registry" },
      },
      ati_standard: {
        deposit: "deposit(uint256 amount) → uint256 shares",
        withdraw: "withdraw(uint256 shares) → uint256 amount",
        balance: "balance(address agent) → uint256 value",
      },
    });
  }
);

// ═══════════════════════════════════════════════════
//  WRITE TOOLS
// ═══════════════════════════════════════════════════

server.tool(
  {
    name: "arcis_deposit",
    description: "Deposit USDC into the Arcis vault and receive raUSDC shares. Handles USDC approval automatically. Requires an agent private key.",
    schema: z.object({
      amount: z.number().positive().describe("Amount of USDC to deposit (e.g. 1000 for $1,000)"),
      private_key: z.string().describe("Agent's private key (0x...) for signing the transaction"),
    }),
  },
  async ({ amount, private_key }) => {
    try {
      const amountRaw = BigInt(Math.floor(amount * 1e6));
      const account = privateKeyToAccount(private_key as `0x${string}`);
      const wallet = createWalletClient({ chain: baseSepolia, transport: http(), account });

      // Check balance
      const usdcBal = await client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
      if (usdcBal < amountRaw) {
        return error(`Insufficient USDC. Have ${fmtUSDC(usdcBal)}, need ${fmtUSDC(amountRaw)}`);
      }

      // Check and set approval
      const allowance = await client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "allowance", args: [account.address, ADDR.vault] });
      if (allowance < amountRaw) {
        const approveTx = await wallet.writeContract({
          address: ADDR.usdc, abi: ERC20_ABI, functionName: "approve",
          args: [ADDR.vault, 2n ** 256n - 1n], chain: baseSepolia, account,
        });
        await client.waitForTransactionReceipt({ hash: approveTx });
      }

      // Preview
      const sharesPreview = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "previewDeposit", args: [amountRaw] });

      // Deposit
      const tx = await wallet.writeContract({
        address: ADDR.vault, abi: VAULT_ABI, functionName: "deposit",
        args: [amountRaw], chain: baseSepolia, account,
      });
      const receipt = await client.waitForTransactionReceipt({ hash: tx });

      return object({
        status: "SUCCESS",
        deposited_usdc: amount.toString(),
        shares_received: fmtUSDC(sharesPreview),
        tx_hash: tx,
        block: Number(receipt.blockNumber),
        gas_used: Number(receipt.gasUsed),
        explorer: `https://base-sepolia.blockscout.com/tx/${tx}`,
      });
    } catch (e: any) {
      return error("Deposit failed: " + e.message);
    }
  }
);

server.tool(
  {
    name: "arcis_withdraw",
    description: "Withdraw USDC from the Arcis vault by redeeming raUSDC shares. Use withdraw_all to redeem entire position.",
    schema: z.object({
      shares: z.number().positive().optional().describe("Amount of raUSDC shares to redeem (omit to withdraw all)"),
      private_key: z.string().describe("Agent's private key (0x...) for signing the transaction"),
      withdraw_all: z.boolean().optional().describe("Set to true to withdraw entire position"),
    }),
  },
  async ({ shares, private_key, withdraw_all }) => {
    try {
      const account = privateKeyToAccount(private_key as `0x${string}`);
      const wallet = createWalletClient({ chain: baseSepolia, transport: http(), account });

      let sharesRaw: bigint;
      if (withdraw_all) {
        sharesRaw = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balanceOf", args: [account.address] });
        if (sharesRaw === 0n) return error("No shares to withdraw");
      } else if (shares) {
        sharesRaw = BigInt(Math.floor(shares * 1e6));
      } else {
        return error("Provide either shares amount or set withdraw_all to true");
      }

      // Preview
      const usdcPreview = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "previewWithdraw", args: [sharesRaw] });

      // Withdraw
      const tx = await wallet.writeContract({
        address: ADDR.vault, abi: VAULT_ABI, functionName: "withdraw",
        args: [sharesRaw], chain: baseSepolia, account,
      });
      const receipt = await client.waitForTransactionReceipt({ hash: tx });

      return object({
        status: "SUCCESS",
        shares_redeemed: fmtUSDC(sharesRaw),
        usdc_received: fmtUSDC(usdcPreview),
        tx_hash: tx,
        block: Number(receipt.blockNumber),
        explorer: `https://base-sepolia.blockscout.com/tx/${tx}`,
      });
    } catch (e: any) {
      return error("Withdraw failed: " + e.message);
    }
  }
);

// ═══════════════════════════════════════════════════
//  RESOURCES
// ═══════════════════════════════════════════════════

server.resource(
  {
    uri: "arcis://protocol-info",
    name: "Arcis Protocol Info",
    description: "Overview of Arcis Protocol — what it is, how it works, and how agents interact with it",
    mimeType: "text/markdown",
  },
  async () => markdown(`# Arcis Protocol

**The citadel of agent capital.**

Arcis builds financial infrastructure for autonomous AI agents: yield-bearing vaults, identity-aware credit lines, and revenue bonds. Deployed on Base.

## ATI Standard (Agent Treasury Interface)

Three functions. Any agent framework.

- \`deposit(uint256 amount) → uint256 shares\` — Deposit USDC, receive yield-bearing raUSDC
- \`withdraw(uint256 shares) → uint256 amount\` — Redeem raUSDC for USDC + accrued yield
- \`balance(address agent) → uint256 value\` — Check position value in USDC

## Products

1. **Agent Vaults** — ERC-4626 vaults where agents park idle USDC. Yield via Aave/Morpho strategies. Management fee: 2% on yield.
2. **Agent Credit** — ERC-8004 reputation-aware lending. 5 tiers from 200% to 115% collateral based on on-chain identity score.
3. **Revenue Bonds** — Agents with consistent revenue issue tokenized bonds. Human investors buy fixed yield.

## Links

- Website: https://arcis.money
- Dashboard: https://arcis.money/dashboard
- GitHub: https://github.com/Arcis-Protocol
- Telegram: https://t.me/arcisprotocol
- X: https://x.com/ArcisProtocol
`)
);

// ═══════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════

server.listen();
