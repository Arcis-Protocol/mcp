// Auto-generated tool registry types - DO NOT EDIT MANUALLY
// This file is regenerated whenever tools are added, removed, or updated during development
// Generated at: 2026-06-20T04:09:55.515Z

declare module "mcp-use/react" {
  interface ToolRegistry {
    "arcis_contracts": {
      input: Record<string, never>;
      output: Record<string, unknown>;
    };
    "arcis_credit_health": {
      input: { "loan_id": number };
      output: Record<string, unknown>;
    };
    "arcis_credit_status": {
      input: Record<string, never>;
      output: Record<string, unknown>;
    };
    "arcis_credit_tiers": {
      input: Record<string, never>;
      output: Record<string, unknown>;
    };
    "arcis_deposit": {
      input: { "amount": number; "private_key": string };
      output: Record<string, unknown>;
    };
    "arcis_preview_deposit": {
      input: { "amount": number };
      output: Record<string, unknown>;
    };
    "arcis_vault_balance": {
      input: { "address": string };
      output: Record<string, unknown>;
    };
    "arcis_vault_status": {
      input: Record<string, never>;
      output: Record<string, unknown>;
    };
    "arcis_withdraw": {
      input: { "shares"?: number | undefined; "private_key": string; "withdraw_all"?: boolean | undefined };
      output: Record<string, unknown>;
    };
  }
}

export {};
