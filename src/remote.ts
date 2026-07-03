import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createArcisServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "3001");

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
      const count = await c.readContract({ address: factory, abi: facAbi, functionName: "vaultCount" }) as bigint;
      const vaults = [];
      for (let i = 0n; i < count; i++) {
        const info = await c.readContract({ address: factory, abi: facAbi, functionName: "vaultInfo", args: [i] }) as [string, string, string, string, bigint, bigint, boolean];
        vaults.push({
          vault: info[0], asset: info[1], name: info[2], symbol: info[3],
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
