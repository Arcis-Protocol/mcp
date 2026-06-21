# @arcisprotocol/mcp

Arcis Protocol MCP Server — connect any AI agent to DeFi vaults in one tool call.

Three deployment modes. 9 tools. Rate-limited writes.

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

Deploy to Railway, Render, or any VPS.

## Mode 3: Vercel Serverless (Claude.ai Custom Connector)

1. Import this repo at [vercel.com/new](https://vercel.com/new)
2. Deploy — zero config
3. Your MCP endpoint: `https://your-project.vercel.app/api/mcp`

Then in Claude.ai: Settings → Connectors → Add → paste the URL.

## Tools

### Read (7 tools)

| Tool | Description |
|---|---|
| `arcis_vault_status` | TVL, exchange rate, supply, capacity, reserve/deployed |
| `arcis_vault_balance` | Agent position: shares, value, USDC wallet |
| `arcis_preview_deposit` | Preview shares for a deposit amount |
| `arcis_credit_status` | Lending pool, total borrowed, utilization |
| `arcis_credit_tiers` | ERC-8004 reputation tier table |
| `arcis_credit_health` | Loan health + total owed |
| `arcis_contracts` | All deployed contract addresses |

### Write (2 tools, 60s rate limit)

| Tool | Description |
|---|---|
| `arcis_deposit` | Deposit USDC → raUSDC (auto-approval) |
| `arcis_withdraw` | Redeem raUSDC → USDC (supports withdraw_all) |

## How It Connects

```
AI Agent ←→ MCP Server ←→ Base Sepolia ←→ Arcis Contracts
```

CUSTOS (the Arcis keeper agent) uses the same contract interfaces. If CUSTOS can operate the protocol autonomously, any agent can.

## Related Repos

| Repo | Description |
|---|---|
| [`core`](https://github.com/Arcis-Protocol/core) | Smart contracts — 17 contracts, 116 tests |
| [`sdk`](https://github.com/Arcis-Protocol/sdk) | `@arcisprotocol/sdk` |
| [`custos`](https://github.com/Arcis-Protocol/custos) | CUSTOS — autonomous keeper agent |
| [`docs`](https://github.com/Arcis-Protocol/docs) | ATI v1.1, integration guide, SDK examples |

---

*ARCIS · @arcisprotocol/mcp · MMXXVI*
