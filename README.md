# @arcisprotocol/mcp

Arcis Protocol MCP Server — connect any AI agent to DeFi vaults in one tool call.

Supports **two modes**: local (stdio) for Claude Desktop/Code, and remote (HTTP) for Claude.ai custom connectors.

## Install

```bash
npm install @arcisprotocol/mcp
```

## Mode 1: Local (Claude Desktop / Claude Code)

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arcis": {
      "command": "npx",
      "args": ["@arcisprotocol/mcp"]
    }
  }
}
```

## Mode 2: Remote (Claude.ai Custom Connector)

Start the HTTP server:

```bash
npx @arcisprotocol/mcp start:remote
# or
PORT=3001 node -e "import('@arcisprotocol/mcp/dist/remote.js')"
```

Then in Claude.ai: **Settings → Connectors → Add Custom Connector** → paste your server URL (e.g. `https://mcp.arcis.money/mcp`).

### Deploy to production

```bash
git clone https://github.com/Arcis-Protocol/mcp.git
cd mcp && npm install && npm run build
PORT=3001 node dist/remote.js
```

Use a reverse proxy (nginx, Caddy) or deploy to Railway / Render / Fly.io for a persistent URL.

## Tools

### Read (no auth required)

| Tool | Description |
|---|---|
| `arcis_vault_status` | TVL, exchange rate, supply, capacity, reserve/deployed |
| `arcis_vault_balance` | Agent position: shares, value, USDC wallet |
| `arcis_preview_deposit` | Preview shares for a deposit amount |
| `arcis_credit_status` | Lending pool, total borrowed, utilization |
| `arcis_credit_tiers` | ERC-8004 reputation tier table |
| `arcis_credit_health` | Check loan health + total owed |
| `arcis_contracts` | All 7 deployed contract addresses |

### Write (private key required)

| Tool | Description |
|---|---|
| `arcis_deposit` | Deposit USDC → raUSDC (auto-approval) |
| `arcis_withdraw` | Redeem raUSDC → USDC (supports withdraw_all) |

### Resources

| URI | Description |
|---|---|
| `arcis://protocol-info` | Protocol overview, ATI spec, product descriptions |

## Network

Currently targets Base Sepolia testnet. Mainnet addresses updated after deployment.

---

*ARCIS · Of the Citadel · MMXXVI*
