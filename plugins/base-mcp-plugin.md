# Arcis Protocol Plugin

> [!IMPORTANT]
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
>
> Before calling any Arcis endpoint, you MUST complete the Base MCP onboarding flow:
> 1. Call `get_wallets` (Detection)
> 2. Present wallet status and disclaimer (Onboarding)
>
> The user's wallet address — required by every call — is only confirmed during Detection.

Arcis Protocol is financial infrastructure for autonomous AI agents. Yield-bearing vaults (raUSDC), identity-aware credit (ERC-8004), and revenue bonds — all accessible through the Agent Treasury Interface (ATI): `deposit()`, `withdraw()`, `balance()`.

This plugin prepares unsigned calldata for Arcis vault operations, then executes via Base MCP's `send_calls`.

**Supported chain:** Base mainnet (`8453` / `0x2105`).

**Fetching calldata:** Arcis calldata is encoded directly from ABI — no external API needed. The assistant constructs the function selector and arguments inline.

---

## Contract Addresses (Base Sepolia — update to mainnet after deployment)

| Contract | Address |
|---|---|
| ArcisVault (raUSDC) | `0xa8eF658E125C7f6D7aFa9B6b8035b66b32CBE98d` |
| AgentCredit | `0x019540E33a0292a9DDE36bD9Ef11774d5A1Ce6FC` |
| ATIRouter | `0x0281e7D37683c585325004F84e0b94170c78d5B4` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

---

## Read Operations

These are view calls — no transaction needed. Use `eth_call` or the Arcis MCP server.

### Vault TVL

```
Function: totalAssets()
Selector: 0x01e1d114
Contract: ArcisVault
Returns: uint256 (USDC amount, 6 decimals)
```

### Agent Balance

```
Function: balance(address agent)
Selector: 0xe3d670d7
Contract: ArcisVault
Returns: uint256 (USDC value of agent's raUSDC shares, 6 decimals)
```

### Agent Shares

```
Function: balanceOf(address account)
Selector: 0x70a08231
Contract: ArcisVault
Returns: uint256 (raUSDC shares, 6 decimals)
```

### Exchange Rate

```
Function: exchangeRate()
Selector: 0x3ba0b9a9
Contract: ArcisVault
Returns: uint256 (USDC per raUSDC, 18 decimals)
```

### Max Deposit

```
Function: maxDeposit(address agent)
Selector: 0x402d267d
Contract: ArcisVault
Returns: uint256 (max USDC the agent can still deposit, 6 decimals)
```

### Preview Deposit

```
Function: previewDeposit(uint256 assets)
Selector: 0xef8b30f7
Contract: ArcisVault
Returns: uint256 (raUSDC shares the agent would receive)
```

### Credit Utilization

```
Function: lendingPool()
Selector: 0x3a85149a
Contract: AgentCredit
Returns: uint256 (available USDC in lending pool, 6 decimals)

Function: totalBorrowed()
Selector: 0x4c19386c
Contract: AgentCredit
Returns: uint256 (total USDC borrowed, 6 decimals)
```

### Effective Borrowing Rate

```
Function: getEffectiveRate(address agent)
Selector: (view)
Contract: AgentCredit
Returns: uint256 (annual rate in bps — 500 = 5.00%)
```

---

## Write Operations — Calldata Preparation

### Deposit USDC into Vault

**Two calls required (approve + deposit), executed atomically via `send_calls`:**

**Step 1 — Approve USDC:**

```
Function: approve(address spender, uint256 amount)
Selector: 0x095ea7b3
Contract: USDC
Arguments:
  spender: <ArcisVault address>
  amount: <deposit amount in USDC raw units, 6 decimals>
```

**Step 2 — Deposit:**

```
Function: deposit(uint256 amount)
Selector: 0xb6b55f25
Contract: ArcisVault
Arguments:
  amount: <same USDC raw amount as approval>
```

### Withdraw from Vault

**Single call — redeem raUSDC shares for USDC:**

```
Function: withdraw(uint256 shares)
Selector: 0x2e1a7d4d
Contract: ArcisVault
Arguments:
  shares: <raUSDC shares to redeem, 6 decimals>
```

### Emergency Withdraw (works even when vault is paused)

```
Function: emergencyWithdraw(uint256 shares)
Selector: (nonpayable)
Contract: ArcisVault
Arguments:
  shares: <raUSDC shares to redeem, 6 decimals>
```

---

## send_calls Mapping

### Deposit

Convert the two-step deposit into a single `send_calls` batch:

```json
{
  "chain": "base",
  "calls": [
    {
      "to": "<USDC address>",
      "value": "0x0",
      "data": "0x095ea7b3<ArcisVault address padded to 32 bytes><amount padded to 32 bytes>"
    },
    {
      "to": "<ArcisVault address>",
      "value": "0x0",
      "data": "0xb6b55f25<amount padded to 32 bytes>"
    }
  ]
}
```

### Withdraw

```json
{
  "chain": "base",
  "calls": [
    {
      "to": "<ArcisVault address>",
      "value": "0x0",
      "data": "0x2e1a7d4d<shares padded to 32 bytes>"
    }
  ]
}
```

---

## Orchestration Pattern

### Deposit Flow

```
1. get_wallets → address
2. Read balance(address) on ArcisVault → current position
3. Read maxDeposit(address) on ArcisVault → remaining capacity
4. Validate: deposit amount ≤ maxDeposit and user has sufficient USDC
5. Read previewDeposit(amount) → expected shares
6. Present to user: "Deposit $X USDC → receive Y raUSDC shares"
7. Encode approve calldata (USDC → ArcisVault, amount)
8. Encode deposit calldata (ArcisVault, amount)
9. send_calls(chain="base", calls=[approve, deposit])
10. User approves in Base App
11. get_request_status(requestId) → confirmed
12. Read balance(address) → verify new position
```

### Withdraw Flow

```
1. get_wallets → address
2. Read balanceOf(address) on ArcisVault → shares held
3. Read balance(address) on ArcisVault → USDC value
4. Present to user: "Withdraw Y shares → receive ~$X USDC"
5. Encode withdraw calldata (ArcisVault, shares)
6. send_calls(chain="base", calls=[withdraw])
7. User approves in Base App
8. get_request_status(requestId) → confirmed
```

### Status Check (no transaction)

```
1. get_wallets → address
2. Read totalAssets() → vault TVL
3. Read exchangeRate() → current rate
4. Read balance(address) → user position value
5. Read balanceOf(address) → user shares
6. Read maxDeposit(address) → remaining capacity
7. Present summary to user
```

---

## MCP Server Alternative

If the Arcis MCP server is installed, use it instead of encoding calldata manually:

```json
{
  "mcpServers": {
    "arcis": { "command": "npx", "args": ["@arcisprotocol/mcp"] }
  }
}
```

The MCP server provides 9 tools including `arcis_vault_status`, `arcis_vault_balance`, `arcis_deposit`, and `arcis_withdraw` with automatic approval handling and rate-limited writes.

npm: `@arcisprotocol/mcp`

---

## Notes

- USDC uses 6 decimals. $1,000 = `1000000000` raw.
- raUSDC shares also use 6 decimals.
- Exchange rate uses 18 decimals. `1000000000000000000` = 1:1 rate.
- Early withdrawals (within 24h of deposit) incur a 0.1% fee (flash loan protection).
- The vault has both a global deposit cap and per-agent cap.
- Emergency withdraw works even when the vault is paused (reserve-only).
- Strategy additions require a 24-hour timelock.

## Links

- Website: [arcis.money](https://arcis.money)
- Dashboard: [arcis.money/dashboard](https://arcis.money/dashboard)
- GitHub: [github.com/Arcis-Protocol](https://github.com/Arcis-Protocol)
- npm SDK: [@arcisprotocol/sdk](https://www.npmjs.com/package/@arcisprotocol/sdk)
- npm MCP: [@arcisprotocol/mcp](https://www.npmjs.com/package/@arcisprotocol/mcp)
- X: [@ArcisProtocol](https://x.com/ArcisProtocol) · [@custos0x](https://x.com/custos0x)
