export interface RuleStats {
  fills: number;
  wins: number;
  losses: number;
  open: number;
  pnl: number;
  spent: number;
}

export interface Fill {
  id: string;
  rule_label: string;
  city: string;
  local_date: string;
  bracket: string;
  signal_price_cents: number | null;
  avg_price: number;
  shares: number;
  spent_usd: number;
  fired_at: string;
  won: boolean | null;
  pnl_usd: number | null;
}
