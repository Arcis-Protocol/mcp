import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, createWalletClient, http, defineChain, type Address } from "viem";

const base = defineChain({
  id: 8453, name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.BASE_RPC_URL || "https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});

const client = createPublicClient({ chain: base, transport: http() });

const ADDR = {
  vault: "0x00325d9da832b38179ed2f0dabd4062d93e325a7" as Address,
  credit: "0xdf31800e620f728297340d66acf5a306f07ce7a1" as Address,
  router: "0xd0c64f997ca9aa427f8834578bd7f0313f868e83" as Address,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  factory: "0x9f5697eEB94ee1C7CEDfEb2080A9398D42170FBC" as Address,
};

const FACTORY_ABI = [
  { name: "vaultCount", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "vaultFor", type: "function", inputs: [{ name: "asset", type: "address" }], outputs: [{ type: "address" }], stateMutability: "view" },
  { name: "vaultInfo", type: "function", inputs: [{ name: "index", type: "uint256" }], outputs: [
    { name: "vault", type: "address" }, { name: "asset", type: "address" },
    { name: "name", type: "string" }, { name: "symbol", type: "string" },
    { name: "totalAssets", type: "uint256" }, { name: "depositCap", type: "uint256" },
    { name: "paused", type: "bool" },
  ], stateMutability: "view" },
] as const;

const TOKEN_ABI = [
  { name: "balanceOf", type: "function", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

function fmtToken(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}

const VAULT_ABI = [
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "asset", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "totalSupply", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "exchangeRate", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "depositCap", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "remainingCapacity", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "reserveBalance", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "deployedBalance", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "paused", type: "function", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "balance", type: "function", inputs: [{ name: "agent", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "previewDeposit", type: "function", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const CREDIT_ABI = [
  { name: "lendingPool", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "totalBorrowed", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "baseRateBps", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "loanCount", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "collateralRatios", type: "function", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "rateDiscounts", type: "function", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "totalOwed", type: "function", inputs: [{ name: "loanId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const fmtUSDC = (v: bigint) => "$" + (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRate = (v: bigint) => (Number(v) / 1e24).toFixed(6);

export function createArcisServer() {
const server = new McpServer({ name: "arcis-protocol", version: "0.3.0" });

server.tool("arcis_vault_status", "Get vault TVL, exchange rate, supply, capacity, reserve/deployed", {}, async () => {
  // Sequential calls to avoid public RPC rate limiting
  const totalAssets = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "totalAssets" });
  const totalSupply = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "totalSupply" });
  const rate = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "exchangeRate" });
  const cap = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "depositCap" });
  const remaining = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "remainingCapacity" });
  const reserve = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "reserveBalance" });
  const deployed = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "deployedBalance" });
  const paused = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "paused" });
  const utilPct = cap > 0n ? (Number(totalAssets * 10000n / cap) / 100).toFixed(2) : "0";
  return { content: [{ type: "text" as const, text: `Arcis Vault (Base Mainnet)\nTVL: ${fmtUSDC(totalAssets)}\nraUSDC Supply: ${Number(totalSupply).toLocaleString()} shares\nExchange Rate: ${fmtRate(rate)}\nDeposit Cap: ${fmtUSDC(cap)}\nRemaining: ${fmtUSDC(remaining)}\nUtilization: ${utilPct}%\nReserve: ${fmtUSDC(reserve)} | Deployed: ${fmtUSDC(deployed)}\nPaused: ${paused}` }] };
});

server.tool("arcis_vault_balance", "Check agent vault position", { agent_address: z.string() }, async ({ agent_address }) => {
  const addr = agent_address as Address;
  const [shares, value, usdcBal] = await Promise.all([
    client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balanceOf", args: [addr] }),
    client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "balance", args: [addr] }),
    client.readContract({ address: ADDR.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] }),
  ]);
  return { content: [{ type: "text" as const, text: `Agent: ${agent_address}\nraUSDC Shares: ${Number(shares).toLocaleString()}\nPosition Value: ${fmtUSDC(value)}\nUSDC Wallet: ${fmtUSDC(usdcBal)}` }] };
});

server.tool("arcis_preview_deposit", "Preview shares for deposit", { amount: z.number() }, async ({ amount }) => {
  const raw = BigInt(Math.floor(amount * 1e6));
  const shares = await client.readContract({ address: ADDR.vault, abi: VAULT_ABI, functionName: "previewDeposit", args: [raw] });
  return { content: [{ type: "text" as const, text: `Depositing $${amount} USDC → ${fmtUSDC(shares)} raUSDC shares` }] };
});

server.tool("arcis_credit_status", "Get lending pool status", {}, async () => {
  const [pool, borrowed, baseRate, loanCount] = await Promise.all([
    client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "lendingPool" }),
    client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalBorrowed" }),
    client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "baseRateBps" }),
    client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "loanCount" }),
  ]);
  const total = pool + borrowed;
  const util = total > 0n ? (Number(borrowed * 10000n / total) / 100).toFixed(2) : "0";
  return { content: [{ type: "text" as const, text: `Agent Credit\nPool: ${fmtUSDC(pool)}\nBorrowed: ${fmtUSDC(borrowed)}\nUtilization: ${util}%\nBase Rate: ${Number(baseRate) / 100}% APR\nLoans: ${loanCount}` }] };
});

server.tool("arcis_credit_tiers", "Get ERC-8004 reputation tiers", {}, async () => {
  const names = ["Unverified", "Basic", "Established", "Trusted", "Elite"];
  const lines = [];
  for (let i = 0; i < 5; i++) {
    const [ratio, discount] = await Promise.all([
      client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "collateralRatios", args: [BigInt(i)] }),
      client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "rateDiscounts", args: [BigInt(i)] }),
    ]);
    lines.push(`Tier ${i} (${names[i]}): ${Number(ratio) / 100}% collateral, -${Number(discount) / 100}% rate`);
  }
  return { content: [{ type: "text" as const, text: `Reputation Tiers\n${lines.join("\n")}` }] };
});

server.tool("arcis_credit_health", "Check loan health", { loan_id: z.number() }, async ({ loan_id }) => {
  const owed = await client.readContract({ address: ADDR.credit, abi: CREDIT_ABI, functionName: "totalOwed", args: [BigInt(loan_id)] });
  return { content: [{ type: "text" as const, text: `Loan #${loan_id}\nTotal Owed: ${fmtUSDC(owed)}` }] };
});

server.tool("arcis_contracts", "Get deployed contract addresses", {}, async () => {
  return { content: [{ type: "text" as const, text: `Arcis Protocol (Base Mainnet)\nArcisVault: ${ADDR.vault}\nATIRouter: ${ADDR.router}\nUSDC: ${ADDR.usdc}\n$CUSTOS Token: 0xD7C479F720b0bC2FF1088A16D1c06C3e11C62882 (Virtuals)
Explorer: https://basescan.org` }] };
});

server.tool("arcis_list_vaults", "List all agent-token vaults from the Arcis factory registry (symbol, asset, TVL, status)", {}, async () => {
  const count = await client.readContract({ address: ADDR.factory, abi: FACTORY_ABI, functionName: "vaultCount" }) as bigint;
  if (count === 0n) {
    return { content: [{ type: "text" as const, text: "No agent-token vaults deployed yet. The flagship USDC vault is at " + ADDR.vault }] };
  }
  const lines: string[] = [`Arcis Agent Vaults (${count} deployed)`];
  for (let i = 0n; i < count; i++) {
    const info = await client.readContract({ address: ADDR.factory, abi: FACTORY_ABI, functionName: "vaultInfo", args: [i] }) as readonly [Address, Address, string, string, bigint, bigint, boolean];
    const [vault, asset, name, symbol, totalAssets, , paused] = info;
    lines.push(`\n${symbol} — ${name}\n  Vault: ${vault}\n  Asset: ${asset}\n  Deposited: ${totalAssets.toString()} (raw)\n  Status: ${paused ? "paused" : "active"}`);
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

server.tool("arcis_vault_info", "Get details for a specific agent-token vault by vault or asset address, including how to deposit", { vault_or_asset: z.string() }, async ({ vault_or_asset }) => {
  let vault = vault_or_asset as Address;
  const viaAsset = await client.readContract({ address: ADDR.factory, abi: FACTORY_ABI, functionName: "vaultFor", args: [vault_or_asset as Address] }) as Address;
  if (viaAsset && viaAsset !== "0x0000000000000000000000000000000000000000") vault = viaAsset;

  const asset = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "asset" }) as Address;
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: asset, abi: TOKEN_ABI, functionName: "decimals" }) as Promise<number>,
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "symbol" }) as Promise<string>,
  ]);
  const totalAssets = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalAssets" }) as bigint;
  const paused = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" }) as boolean;

  const text = `Arcis Vault: ${symbol}\nVault: ${vault}\nUnderlying asset: ${asset} (${decimals} decimals)\nTotal deposited: ${fmtToken(totalAssets, Number(decimals))} ${symbol}\nStatus: ${paused ? "paused" : "active"}\n\nTo deposit: approve the vault to spend your token, then call deposit(amount) on the vault. You receive ${symbol} receipt shares 1:1. Withdraw anytime with withdraw(shares).\nCLI: arcis vault deposit-token ${vault} <amount> -k <key>`;
  return { content: [{ type: "text" as const, text }] };
});

server.tool("arcis_agent_vault_balance", "Check an agent's position in a specific agent-token vault", { vault_or_asset: z.string(), agent_address: z.string() }, async ({ vault_or_asset, agent_address }) => {
  let vault = vault_or_asset as Address;
  const viaAsset = await client.readContract({ address: ADDR.factory, abi: FACTORY_ABI, functionName: "vaultFor", args: [vault_or_asset as Address] }) as Address;
  if (viaAsset && viaAsset !== "0x0000000000000000000000000000000000000000") vault = viaAsset;

  const asset = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "asset" }) as Address;
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: asset, abi: TOKEN_ABI, functionName: "decimals" }) as Promise<number>,
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "symbol" }) as Promise<string>,
  ]);
  const [shares, walletBal] = await Promise.all([
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "balanceOf", args: [agent_address as Address] }) as Promise<bigint>,
    client.readContract({ address: asset, abi: TOKEN_ABI, functionName: "balanceOf", args: [agent_address as Address] }) as Promise<bigint>,
  ]);
  const text = `Agent: ${agent_address}\nVault: ${symbol} (${vault})\nVault position: ${fmtToken(shares, Number(decimals))} ${symbol}\nWallet balance: ${fmtToken(walletBal, Number(decimals))} (underlying token)`;
  return { content: [{ type: "text" as const, text }] };
});

return server;
}

// Singleton for stdio mode
export const server = createArcisServer();
