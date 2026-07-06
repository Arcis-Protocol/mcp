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
