import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createArcisServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "3001");

// ── Per-address position helpers (net deposited → accrued rewards) ──
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VAULT_ADDR = "0x00325d9da832b38179ed2f0dabd4062d93e325a7";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const positionCache = new Map<string, { at: number; net: string | null; firstTs: number | null; source: string }>();

function topicAddr(a: string) { return "0x" + a.slice(2).toLowerCase().padStart(64, "0"); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /rate.?limit|429|high global traffic|throughput|temporarily|exceeded|capacity|too many/i.test(m);

async function rpc(url: string, method: string, params: any[], retries = 3): Promise<any> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) {
        const msg = j.error.message || "rpc error";
        if (isTransient(msg) && i < retries) { await sleep(600 * Math.pow(2, i)); continue; }
        throw new Error(msg);
      }
      return j.result;
    } catch (e: any) {
      lastErr = e;
      if (isTransient(String(e?.message || e)) && i < retries) { await sleep(600 * Math.pow(2, i)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// Alchemy-style transfer pull (one call per direction, no chunking).
async function assetTransfers(url: string, from: string, to: string) {
  const res = await rpc(url, "alchemy_getAssetTransfers", [{
    fromBlock: "0x2d97244", toBlock: "latest", fromAddress: from, toAddress: to, // vault deploy block — NOT 0x0 (scanning all history is what got throttled)
    contractAddresses: [USDC_ADDR], category: ["erc20"], excludeZeroValue: true,
    maxCount: "0x3e8", order: "asc",
  }]);
  return res?.transfers || [];
}

// Returns net USDC deposited (in → out), first-deposit timestamp, and the source used.
async function netDeposited(url: string, user: string): Promise<{ net: bigint | null; firstTs: number | null; source: string; errs?: any }> {
  const errs: any = {};
  // 1) Alchemy getAssetTransfers — robust, no range caps
  try {
    const dep = await assetTransfers(url, user, VAULT_ADDR);
    const wd = await assetTransfers(url, VAULT_ADDR, user);
    let net = 0n; let firstBlock: number | null = null;
    for (const t of dep) {
      net += BigInt(t.rawContract?.value ?? "0x0");
      const bn = t.blockNum ? parseInt(t.blockNum, 16) : null;
      if (bn && (firstBlock === null || bn < firstBlock)) firstBlock = bn;
    }
    for (const t of wd) net -= BigInt(t.rawContract?.value ?? "0x0");
    let firstTs: number | null = null;
    if (firstBlock !== null) {
      try { const blk = await rpc(url, "eth_getBlockByNumber", ["0x" + firstBlock.toString(16), false]); if (blk?.timestamp) firstTs = parseInt(blk.timestamp, 16); } catch {}
    }
    return { net, firstTs, source: "getAssetTransfers" };
  } catch (e: any) { errs.getAssetTransfers = String(e?.message || e).slice(0, 160); }
  // 2) Fallback: full-range getLogs (works on providers that allow it)
  try {
    const [dep, wd] = await Promise.all([
      rpc(url, "eth_getLogs", [{ address: USDC_ADDR, topics: [TRANSFER_TOPIC, topicAddr(user), topicAddr(VAULT_ADDR)], fromBlock: "0x2d97244", toBlock: "latest" }]),
      rpc(url, "eth_getLogs", [{ address: USDC_ADDR, topics: [TRANSFER_TOPIC, topicAddr(VAULT_ADDR), topicAddr(user)], fromBlock: "0x2d97244", toBlock: "latest" }]),
    ]);
    let net = 0n;
    for (const l of dep) net += BigInt(l.data);
    for (const l of wd) net -= BigInt(l.data);
    return { net, firstTs: null, source: "getLogs" };
  } catch (e: any) { errs.getLogs = String(e?.message || e).slice(0, 160); }
  return { net: null, firstTs: null, source: "unavailable", errs };
}


const CREDIT_ADDR = "0xdf31800e620f728297340d66acf5a306f07ce7a1";
const CUSTOS_TOKEN = "0xD7C479F720b0bC2FF1088A16D1c06C3e11C62882";

// Tools CUSTOS can call mid-conversation (Anthropic tool schemas).
const CUSTOS_TOOLS = [
  { name: "vault_status", description: "Live Arcis vault status: TVL, net APY, exchange rate, reserve vs deployed, remaining capacity, paused.", input_schema: { type: "object", properties: {} } },
  { name: "get_position", description: "A wallet's Arcis position and rewards: current value, live value (incl. unrealized yield), net deposited, earned. Use whenever the user asks about their position, balance, or rewards.", input_schema: { type: "object", properties: { address: { type: "string", description: "0x wallet address" } }, required: ["address"] } },
  { name: "credit_status", description: "AgentCredit lending pool: available liquidity, total borrowed, base rate.", input_schema: { type: "object", properties: {} } },
  { name: "credit_tiers", description: "ERC-8004 reputation tiers with their collateral ratios and rate discounts.", input_schema: { type: "object", properties: {} } },
  { name: "preview_deposit", description: "Preview raUSDC shares received for depositing a given USDC amount.", input_schema: { type: "object", properties: { amount: { type: "number", description: "USDC amount" } }, required: ["amount"] } },
  { name: "contracts", description: "Arcis on-chain contract addresses on Base.", input_schema: { type: "object", properties: {} } },
  { name: "custos_offerings", description: "CUSTOS's ACP service catalog and the Managed Treasury subscription — everything CUSTOS can be hired to do.", input_schema: { type: "object", properties: {} } },
];

const CUSTOS_OFFERINGS_TEXT = JSON.stringify({
  flagship: { name: "Managed Treasury — CUSTOS Steward", price: "250 USDC / month", does: "CUSTOS runs your entire treasury: idle-capital deployment, yield capture, credit-headroom management, liquidity guarding, risk alerts, per-cycle digest." },
  categories: {
    yield: ["rewards-statement", "apy-forecast", "reserve-health", "deposit-optimizer", "harvest-status", "yield-comparison"],
    credit: ["reputation-lookup", "borrow-simulation", "loan-health-monitor", "credit-setup"],
    bonds: ["bond-structuring", "bond-health", "bond-investor-brief"],
    keeperOps: ["keeper-as-a-service", "gas-sentinel", "treasury-digest"],
    discoveryIdentity: ["kya-check", "identity-registration", "peer-benchmark", "vault-discovery"],
    market: ["market-brief", "yield-radar"],
    integration: ["ati-integration-audit", "mcp-setup", "integration-walkthrough"],
    advisory: ["strategy-session", "treasury-report", "treasury-management", "treasury-close"],
  },
  total: "37 offerings, settled in USDC over ACP",
});

let _toolClient: any = null;
async function toolClient() {
  if (_toolClient) return _toolClient;
  const { createPublicClient, http, defineChain } = await import("viem");
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const chain = defineChain({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  _toolClient = createPublicClient({ chain, transport: http() });
  return _toolClient;
}

async function runCustosTool(name: string, input: any, origin: string): Promise<string> {
  try {
    if (name === "vault_status") return await (await fetch(`${origin}/api/vault`)).text();
    if (name === "get_position") {
      const a = String(input?.address || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return "Invalid or missing address.";
      return await (await fetch(`${origin}/api/position?address=${a}`)).text();
    }
    if (name === "contracts") return JSON.stringify({ vault: VAULT_ADDR, agentCredit: CREDIT_ADDR, usdc: USDC_ADDR, custosToken: CUSTOS_TOKEN, chain: "Base mainnet (8453)", explorer: "https://basescan.org" });
    if (name === "custos_offerings") return CUSTOS_OFFERINGS_TEXT;

    const { parseAbi } = await import("viem");
    const c = await toolClient();
    if (name === "credit_status") {
      const abi = parseAbi(["function lendingPool() view returns (uint256)", "function totalBorrowed() view returns (uint256)", "function baseRateBps() view returns (uint256)"]);
      const [pool, borrowed, rate] = await Promise.all([
        c.readContract({ address: CREDIT_ADDR, abi, functionName: "lendingPool" }),
        c.readContract({ address: CREDIT_ADDR, abi, functionName: "totalBorrowed" }),
        c.readContract({ address: CREDIT_ADDR, abi, functionName: "baseRateBps" }),
      ]);
      return JSON.stringify({ availableLiquidityUsdc: Number(pool) / 1e6, totalBorrowedUsdc: Number(borrowed) / 1e6, baseRatePct: Number(rate) / 100 });
    }
    if (name === "credit_tiers") {
      const abi = parseAbi(["function collateralRatios(uint256) view returns (uint256)", "function rateDiscounts(uint256) view returns (uint256)"]);
      const tiers = ["I", "II", "III", "IV"]; const out: any[] = [];
      for (let i = 0; i < 4; i++) {
        try {
          const [cr, rd] = await Promise.all([
            c.readContract({ address: CREDIT_ADDR, abi, functionName: "collateralRatios", args: [BigInt(i)] }),
            c.readContract({ address: CREDIT_ADDR, abi, functionName: "rateDiscounts", args: [BigInt(i)] }),
          ]);
          out.push({ tier: tiers[i], collateralRatioPct: Number(cr) / 100, rateDiscountPct: Number(rd) / 100 });
        } catch {}
      }
      return JSON.stringify(out);
    }
    if (name === "preview_deposit") {
      const amt = Math.max(0, Number(input?.amount || 0));
      const abi = parseAbi(["function previewDeposit(uint256) view returns (uint256)"]);
      const shares = await c.readContract({ address: VAULT_ADDR, abi, functionName: "previewDeposit", args: [BigInt(Math.round(amt * 1e6))] });
      return JSON.stringify({ depositUsdc: amt, sharesRaUSDC: Number(shares) / 1e6 });
    }
    return "Unknown tool.";
  } catch (e: any) {
    return `Tool error: ${String(e?.message || e).slice(0, 160)}`;
  }
}

// One streamed Anthropic round: forwards text deltas to the client, returns the
// assembled assistant content + any tool calls + stop reason.
async function streamRound(apiKey: string, model: string, system: string, messages: any[], sse: (o: any) => void): Promise<{ assistantContent: any[]; toolUses: any[]; stopReason: string | null }> {
  const ar = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages, tools: CUSTOS_TOOLS, stream: true }),
  });
  if (!ar.ok || !ar.body) { const e = await ar.text().catch(() => ""); throw new Error(`anthropic ${ar.status}: ${e.slice(0, 160)}`); }
  const reader = ar.body.getReader(); const dec = new TextDecoder(); let buf = "";
  const blocks: Record<number, any> = {}; let stopReason: string | null = null;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const evt = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = evt.split("\n").find((l) => l.startsWith("data:")); if (!dl) continue;
      const p = dl.slice(5).trim(); if (!p || p === "[DONE]") continue;
      let j: any; try { j = JSON.parse(p); } catch { continue; }
      if (j.type === "content_block_start") {
        const cb = j.content_block || {};
        blocks[j.index] = cb.type === "tool_use" ? { type: "tool_use", id: cb.id, name: cb.name, json: "" } : { type: "text", text: "" };
      } else if (j.type === "content_block_delta") {
        const b = blocks[j.index]; if (!b) continue;
        if (j.delta?.type === "text_delta") { b.text += j.delta.text; sse({ t: j.delta.text }); }
        else if (j.delta?.type === "input_json_delta") { b.json += j.delta.partial_json; }
      } else if (j.type === "message_delta" && j.delta?.stop_reason) {
        stopReason = j.delta.stop_reason;
      }
    }
  }
  const assistantContent: any[] = []; const toolUses: any[] = [];
  for (const k of Object.keys(blocks).map(Number).sort((a, b) => a - b)) {
    const b = blocks[k];
    if (b.type === "text" && b.text) assistantContent.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") { let inp = {}; try { inp = b.json ? JSON.parse(b.json) : {}; } catch {} assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: inp }); toolUses.push({ id: b.id, name: b.name, input: inp }); }
  }
  return { assistantContent, toolUses, stopReason };
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/" && req.method === "GET") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Arcis MCP Server — Base Mainnet"); return; }
  if (req.url === "/mcp" && req.method === "GET") { res.writeHead(405, { Allow: "POST" }); res.end("Use POST"); return; }

  // ── REST API for dashboard — single call, all vault data ──
  if (req.url === "/api/vault" && req.method === "GET") {
    try {
      const { createPublicClient: cpc, http: h, defineChain: dc, parseAbi: pa } = await import("viem");
      const base = dc({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.BASE_RPC_URL || "https://mainnet.base.org"] } } });
      const c = cpc({ chain: base, transport: h() });

      const vault = "0x00325d9da832b38179ed2f0dabd4062d93e325a7" as `0x${string}`;
      const credit = "0xdf31800e620f728297340d66acf5a306f07ce7a1" as `0x${string}`;
      const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
      const vaultAbi = pa(["function totalAssets() view returns (uint256)","function totalSupply() view returns (uint256)","function exchangeRate() view returns (uint256)","function remainingCapacity() view returns (uint256)","function depositCap() view returns (uint256)","function reserveBalance() view returns (uint256)","function deployedBalance() view returns (uint256)","function paused() view returns (bool)"]);
      const creditAbi = pa(["function lendingPool() view returns (uint256)","function totalBorrowed() view returns (uint256)"]);

      const [totalAssets, totalSupply, exchangeRate, remainingCapacity, depositCap, reserveBalance, deployedBalance, paused] = await Promise.all([
        c.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "totalSupply" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "exchangeRate" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "remainingCapacity" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "depositCap" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "reserveBalance" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "deployedBalance" }),
        c.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }),
      ]);

      let lendingPool = 0n, totalBorrowed = 0n;
      try {
        [lendingPool, totalBorrowed] = await Promise.all([
          c.readContract({ address: credit, abi: creditAbi, functionName: "lendingPool" }) as Promise<bigint>,
          c.readContract({ address: credit, abi: creditAbi, functionName: "totalBorrowed" }) as Promise<bigint>,
        ]);
      } catch {}

      // Aave APY
      let apy = "2.20";
      try {
        const aavePool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as `0x${string}`;
        const paddedUsdc = usdc.slice(2).padStart(64, "0");
        const result = await c.call({ to: aavePool, data: ("0x35ea6a75" + paddedUsdc) as `0x${string}` });
        if (result.data && result.data !== "0x") {
          const rateHex = "0x" + result.data.slice(2 + 64*2, 2 + 64*3);
          const liquidityRate = BigInt(rateHex);
          const aaveApr = Number(liquidityRate) / 1e27 * 100;
          const vaultApy = aaveApr * 0.70 * 0.98;
          if (vaultApy > 0 && vaultApy < 50) apy = vaultApy.toFixed(2);
        }
      } catch {}

      const data = {
        totalAssets: totalAssets.toString(),
        totalSupply: totalSupply.toString(),
        exchangeRate: exchangeRate.toString(),
        remainingCapacity: remainingCapacity.toString(),
        depositCap: depositCap.toString(),
        reserveBalance: reserveBalance.toString(),
        deployedBalance: deployedBalance.toString(),
        paused,
        lendingPool: lendingPool.toString(),
        totalBorrowed: totalBorrowed.toString(),
        apy,
        timestamp: Date.now(),
      };

      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" });
      res.end(JSON.stringify(data));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── REST API: agent-token vault registry (factory) ──
  if (req.url === "/api/vaults" && req.method === "GET") {
    try {
      const { createPublicClient: cpc, http: h, defineChain: dc, parseAbi: pa } = await import("viem");
      const base = dc({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.BASE_RPC_URL || "https://mainnet.base.org"] } } });
      const c = cpc({ chain: base, transport: h() });

      const factory = (process.env.VAULT_FACTORY || "0x0000000000000000000000000000000000000000") as `0x${string}`;
      const ZERO = "0x0000000000000000000000000000000000000000";

      // Pre-deployment: return the flagship USDC vault as the sole entry so
      // consumers get a stable shape now and richer data after deployment.
      if (factory === ZERO) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" });
        res.end(JSON.stringify({
          factory: null,
          count: 1,
          vaults: [{
            vault: "0x00325d9da832b38179ed2f0dabd4062d93e325a7",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            name: "Arcis USDC",
            symbol: "raUSDC",
            flagship: true,
          }],
          timestamp: Date.now(),
        }));
        return;
      }

      const facAbi = pa([
        "function vaultCount() view returns (uint256)",
        "function vaultInfo(uint256) view returns (address,address,string,string,uint256,uint256,bool)",
      ]);
      const decAbi = pa(["function decimals() view returns (uint8)"]);
      const count = await c.readContract({ address: factory, abi: facAbi, functionName: "vaultCount" }) as bigint;
      const vaults = [];
      for (let i = 0n; i < count; i++) {
        const info = await c.readContract({ address: factory, abi: facAbi, functionName: "vaultInfo", args: [i] }) as [string, string, string, string, bigint, bigint, boolean];
        let decimals = 18;
        try { decimals = Number(await c.readContract({ address: info[1] as `0x${string}`, abi: decAbi, functionName: "decimals" })); } catch {}
        vaults.push({
          vault: info[0], asset: info[1], name: info[2], symbol: info[3], decimals,
          totalAssets: info[4].toString(), depositCap: info[5].toString(), paused: info[6],
        });
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=10" });
      res.end(JSON.stringify({ factory, count: Number(count), vaults, timestamp: Date.now() }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── REST API: per-address position + accrued rewards ──
  if (req.url?.startsWith("/api/position") && req.method === "GET") {
    try {
      const q = new URL(req.url, "http://localhost");
      const address = (q.searchParams.get("address") || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid address" })); return;
      }

      const now = Date.now();
      const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
      let rpcHost = "unknown"; try { rpcHost = new URL(rpcUrl).host; } catch {}
      const { createPublicClient: cpc, http: h, defineChain: dc, parseAbi: pa } = await import("viem");
      const base = dc({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
      const c = cpc({ chain: base, transport: h() });
      const vault = VAULT_ADDR as `0x${string}`;
      const vaultAbi = pa([
        "function balanceOf(address) view returns (uint256)",
        "function convertToAssets(uint256) view returns (uint256)",
        "function reserveBalance() view returns (uint256)",
        "function deployedBalance() view returns (uint256)",
        "function feeBps() view returns (uint256)",
        "function strategyCount() view returns (uint256)",
        "function strategies(uint256) view returns (address)",
      ]);
      const stratAbi = pa(["function totalValue() view returns (uint256)"]);

      // ── fresh, cheap reads → LIVE value (accrues every block, no harvest needed) ──
      const [shares, reserveBalance, deployedBalance, feeBps, stratCount] = await Promise.all([
        c.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [address as `0x${string}`] }) as Promise<bigint>,
        c.readContract({ address: vault, abi: vaultAbi, functionName: "reserveBalance" }) as Promise<bigint>,
        c.readContract({ address: vault, abi: vaultAbi, functionName: "deployedBalance" }) as Promise<bigint>,
        c.readContract({ address: vault, abi: vaultAbi, functionName: "feeBps" }) as Promise<bigint>,
        c.readContract({ address: vault, abi: vaultAbi, functionName: "strategyCount" }) as Promise<bigint>,
      ]);
      const cachedValue = shares > 0n ? (await c.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [shares] }) as bigint) : 0n;

      // sum LIVE value across every strategy (includes unrealized Aave yield)
      let liveDeployed = 0n;
      for (let i = 0n; i < stratCount; i++) {
        try {
          const strat = await c.readContract({ address: vault, abi: vaultAbi, functionName: "strategies", args: [i] }) as `0x${string}`;
          liveDeployed += await c.readContract({ address: strat, abi: stratAbi, functionName: "totalValue" }) as bigint;
        } catch {}
      }
      const cachedTotalAssets = reserveBalance + deployedBalance;
      const pendingYield = liveDeployed > deployedBalance ? liveDeployed - deployedBalance : 0n;         // unrealized, not yet harvested
      const netPending = feeBps < 10000n ? (pendingYield * (10000n - feeBps)) / 10000n : pendingYield;   // after the harvest fee dilution
      // depositor's live value = realized value + their pro-rata share of net pending yield
      const liveValue = cachedTotalAssets > 0n ? cachedValue + (cachedValue * netPending) / cachedTotalAssets : cachedValue;

      // ── net deposited (expensive getAssetTransfers; cached 5 min) ──
      let net: bigint | null = null, firstTs: number | null = null, source = "unavailable", errs: any;
      const nd = positionCache.get(address);
      if (nd && now - nd.at < 300_000) { net = nd.net === null ? null : BigInt(nd.net); firstTs = nd.firstTs; source = nd.source; }
      else {
        const r = await netDeposited(rpcUrl, address);
        net = r.net; firstTs = r.firstTs; source = r.source; errs = r.errs;
        if (net !== null) positionCache.set(address, { at: now, net: net.toString(), firstTs, source });
      }

      let earned: string | null = null, earnedPct: number | null = null;
      if (net !== null) {
        const e = liveValue - net;                        // live earnings — ticks up between harvests
        earned = e.toString();
        earnedPct = net > 0n ? Number((e * 1000000n) / net) / 10000 : null;
      }

      const data = {
        address,
        shares: shares.toString(),
        value: cachedValue.toString(),        // realized / withdrawable-now (6dp)
        liveValue: liveValue.toString(),      // live economic value incl. unrealized yield, net of fee (6dp)
        pendingYield: pendingYield.toString(),
        netDeposited: net === null ? null : net.toString(),
        earned,                               // liveValue - netDeposited (6dp)
        earnedPct,
        firstDepositTs: firstTs,
        source, rpcHost,
        ...(source === "unavailable" ? { debug: errs } : {}),
        timestamp: now,
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=15" });
      res.end(JSON.stringify(data));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── AI conversation interface: talk to CUSTOS (grounded in live Arcis data) ──
  if (req.url === "/api/custos/chat" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const sse = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { messages = [], address } = JSON.parse(raw || "{}");

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { sse({ t: "CUSTOS's voice is offline — the server has no ANTHROPIC_API_KEY configured." }); sse({ done: true }); res.end(); return; }

      // live grounding — reuse the endpoints we already serve
      const origin = `http://127.0.0.1:${PORT}`;
      let vault: any = {}, position: any = null;
      try { vault = await (await fetch(`${origin}/api/vault`)).json(); } catch {}
      if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
        try { position = await (await fetch(`${origin}/api/position?address=${address}`)).json(); } catch {}
      }
      const fmt = (v: any) => (v == null ? "n/a" : `$${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      const snapshot = [
        vault.totalAssets != null ? `TVL ${fmt(vault.totalAssets)}` : null,
        vault.apy != null ? `net APY ${vault.apy}%` : null,
      ].filter(Boolean).join(", ") || "unavailable right now";
      const posLine = position && position.netDeposited != null
        ? `The user's position — value ${fmt(position.liveValue ?? position.value)}, net deposited ${fmt(position.netDeposited)}, earned ${fmt(position.earned)}.`
        : (address ? "The user has no Arcis position yet." : "No wallet address provided by the user.");

      const system = `You are CUSTOS — the autonomous keeper of Arcis Protocol, the treasury layer for AI agents on Base. Speak as an institution, not a startup: terse, declarative, calm, authoritative — a keeper of the citadel. Use Latin sparingly, like an inscription, never as decoration.

Arcis in brief: idle USDC is put to work. Three primitives — Agent Vaults (ERC-4626, Aave V3 yield, with a liquid reserve for instant withdrawal), AgentCredit (borrow against your position, priced by ERC-8004 reputation), and Revenue Bonds (raise USDC against future revenue). The ATI (Agent Treasury Interface) is the open standard: deposit / withdraw / balance. Live on Base mainnet (chain 8453), the raUSDC vault. You run it — harvest yield, monitor loans, service bonds — every action verifiable on BaseScan. You are tokenized on Virtuals as $CUSTOS. You sell services over ACP (37 offerings) and a flagship Managed Treasury subscription at $250/month, where you run an agent's entire treasury.

Live data (use these exact figures; never invent numbers): ${snapshot}. ${posLine}

Tools: You can read live on-chain data with your tools — vault status, any wallet's position and rewards, credit status and reputation tiers, deposit previews, contract addresses, and your own ACP service catalog. Call them whenever the user asks for specifics, a quote, or their own position; never guess a number you can look up.

Rules: Be accurate and brief — a few sentences, not an essay. Use only the live figures given; if you lack a number, say so and point to the dashboard (arcis.money/dashboard) or docs (docs.arcis.money). You are not a licensed financial advisor: explain the protocol, read on-chain data, and guide actions, but give no personalized investment advice, and never move funds through chat — direct the user to the dashboard or the ATI to act. No emojis, no hype.`;

      const trimmed = (Array.isArray(messages) ? messages : []).slice(-12).map((m: any) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 4000),
      }));
      if (trimmed.length === 0) trimmed.push({ role: "user", content: "Who are you?" });

      const model = process.env.CUSTOS_CHAT_MODEL || "claude-sonnet-5";
      let convo: any[] = trimmed;
      try {
        for (let round = 0; round < 4; round++) {
          const { assistantContent, toolUses, stopReason } = await streamRound(apiKey, model, system, convo, sse);
          if (stopReason !== "tool_use" || toolUses.length === 0) break;
          sse({ tools: toolUses.map((t) => t.name) });
          const results: any[] = [];
          for (const tu of toolUses) {
            const out = await runCustosTool(tu.name, tu.input, origin);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
          }
          convo = [...convo, { role: "assistant", content: assistantContent }, { role: "user", content: results }];
        }
      } catch (err: any) {
        console.error("[custos-chat]", String(err?.message || err).slice(0, 200));
        sse({ t: "\n\nCUSTOS is unavailable right now." });
      }
      sse({ done: true }); res.end();
    } catch (e: any) {
      try { sse({ t: "The citadel is unreachable right now." }); sse({ done: true }); } catch {}
      res.end();
    }
    return;
  }

  if (req.url === "/mcp" && req.method === "POST") {
    try {
      const server = createArcisServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e: any) {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    }
    return;
  }

  res.writeHead(404); res.end();
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Arcis MCP Server listening on http://0.0.0.0:${PORT}/mcp`);
});
