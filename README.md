# @arcisprotocol/mcp

Arcis Protocol MCP Server — connect any AI agent to DeFi vaults in one tool call.

Three deployment modes: local stdio, self-hosted HTTP, and Vercel serverless.

## Mode 1: Local (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "arcis": { "command": "npx", "args": ["@arcisprotocol/mcp"] }
  }
}
```

## Mode 2: Self-Hosted HTTP

```bash
PORT=3001 npx @arcisprotocol/mcp start:remote
```

Deploy to Railway, Render, or Fly.io for a persistent URL.

## Mode 3: Vercel Serverless (Claude.ai Custom Connector)

This repo deploys directly to Vercel as a Next.js app with Streamable HTTP transport.

1. Import this repo at [vercel.com/new](https://vercel.com/new)
2. Deploy — zero config needed
3. Your MCP endpoint: `https://your-project.vercel.app/api/mcp`

Then in Claude.ai: **Settings → Connectors → Add Custom Connector** → paste the URL.

Uses `mcp-handler` — Vercel's official MCP deployment package.

## Tools

### Read (7 tools, no auth)

| Tool | Description |
|---|---|
| `arcis_vault_status` | TVL, exchange rate, supply, capacity, reserve/deployed |
| `arcis_vault_balance` | Agent position: shares, value, USDC wallet |
| `arcis_preview_deposit` | Preview shares for a deposit amount |
| `arcis_credit_status` | Lending pool, total borrowed, utilization |
| `arcis_credit_tiers` | ERC-8004 reputation tier table |
| `arcis_credit_health` | Check loan health + total owed |
| `arcis_contracts` | All deployed contract addresses |

### Write (2 tools, rate-limited)

| Tool | Description |
|---|---|
| `arcis_deposit` | Deposit USDC → raUSDC (auto-approval, 60s cooldown) |
| `arcis_withdraw` | Redeem raUSDC → USDC (supports withdraw_all) |

## Project Structure

```
src/
  index.ts       → stdio entry (npx / Claude Desktop)
  remote.ts      → HTTP entry (self-hosted, PORT env)
  server.ts      → shared tool definitions (mcp-use)
app/
  api/mcp/
    route.ts     → Vercel serverless (mcp-handler, Streamable HTTP)
  page.tsx       → Landing page at /
```

## Network

Base Sepolia testnet. Mainnet addresses updated after deployment.

---

*ARCIS · Of the Citadel · MMXXVI*
