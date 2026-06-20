# @arcis/mcp

Arcis Protocol MCP Server — connect any AI agent to DeFi vaults in one tool call.

## What This Does

Any LLM that supports MCP (Claude, GPT, etc.) can interact with Arcis Protocol's on-chain contracts through natural language. No SDK, no code, no ABI decoding. The agent says "deposit 1000 USDC into Arcis" and the MCP tool handles everything.

## Tools

### Read (no auth required)

| Tool | Description |
|---|---|
| `arcis_vault_status` | TVL, exchange rate, supply, capacity, reserve/deployed |
| `arcis_vault_balance` | Agent position: shares, value, USDC wallet |
| `arcis_preview_deposit` | Preview shares received for a given deposit |
| `arcis_credit_status` | Lending pool, total borrowed, utilization |
| `arcis_credit_tiers` | ERC-8004 reputation tier table |
| `arcis_credit_health` | Check if a loan is healthy |
| `arcis_contracts` | All 7 deployed contract addresses |

### Write (private key required)

| Tool | Description |
|---|---|
| `arcis_deposit` | Deposit USDC → receive raUSDC (auto-approves) |
| `arcis_withdraw` | Redeem raUSDC → receive USDC (supports withdraw_all) |

### Resources

| URI | Description |
|---|---|
| `arcis://protocol-info` | Protocol overview, ATI spec, product descriptions |

## Setup

```bash
git clone https://github.com/Arcis-Protocol/mcp.git
cd mcp && npm install
npm run dev
```

## Connect to Claude

Add to your Claude desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "arcis": {
      "command": "npx",
      "args": ["tsx", "/path/to/arcis-mcp/src/index.ts"]
    }
  }
}
```

## Example Interactions

> "What's the TVL on Arcis?"
> → Calls `arcis_vault_status`, returns $11,250.00

> "Check agent 0xB390...57db's position"
> → Calls `arcis_vault_balance`, returns shares + value + wallet

> "Deposit 500 USDC"
> → Calls `arcis_deposit`, handles approval, returns tx hash + explorer link

> "What are the credit tiers?"
> → Calls `arcis_credit_tiers`, returns 5-tier table with collateral ratios

## Network

Currently targets Base Sepolia testnet. Mainnet addresses will be updated after deployment.

## Related Repos

| Repo | Description |
|---|---|
| [`core`](https://github.com/Arcis-Protocol/core) | Smart contracts (Foundry) |
| [`sdk`](https://github.com/Arcis-Protocol/sdk) | TypeScript SDK |
| [`cli`](https://github.com/Arcis-Protocol/cli) | Terminal interface (TUI) |
| [`app`](https://github.com/Arcis-Protocol/app) | arcis.money |
| [`docs`](https://github.com/Arcis-Protocol/docs) | Protocol documentation |

---

*ARCIS · Of the Citadel · MMXXVI*
