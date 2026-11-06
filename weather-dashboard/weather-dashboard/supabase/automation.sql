-- Run once in the Supabase SQL editor (Project > SQL).
-- Both tables are private: row level security is on with no policies, so only the
-- service-role key used by the weather server can read or write them.

create table if not exists public.automation_rules (
  id               uuid primary key default gen_random_uuid(),
  label            text        not null,
  criteria_key     text        not null,            -- pipe-joined bucket keys, e.g. rank_h:4:1
  by_param         text        not null,            -- the `by` text the scanner takes, e.g. rank_at_hour:4
  dims             jsonb,                           -- the pinned dimension list, kept for display
  method           text        not null default 'combined'
                   check (method in ('combined','linear','reciprocal','all')),
  cities           text[]      not null default '{}',   -- empty = every city
  enabled          boolean     not null default false,
  stake_usd        numeric(6,2) not null default 1 check (stake_usd >= 1 and stake_usd <= 5),
  max_price_cents  integer     check (max_price_cents between 1 and 99),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (criteria_key, method, cities)
);

create table if not exists public.automation_fills (
  id                  uuid primary key default gen_random_uuid(),
  rule_id             uuid references public.automation_rules(id) on delete set null,
  rule_label          text        not null,         -- copied at buy time, survives rule deletion
  criteria_key        text        not null,
  method              text,
  city                text        not null,
  local_date          date        not null,
  bracket             text        not null,
  token_id            text,
  intent_id           text        not null unique,  -- sha256(rule|city|date|bracket), first 32 hex
  signal_price_cents  numeric(6,2),                 -- price on the closing tick, when it priced this bracket
  signal_pacing_time  text,                         -- label of that tick, e.g. '11:30 AM'
  signal_tick_at      timestamptz,                  -- when that tick was stored
  stake_usd           numeric(8,2) not null,
  avg_price           numeric(8,6) not null,        -- 0..1, what PolyBot actually paid per share
  shares              numeric(18,6) not null,
  spent_usd           numeric(10,4) not null,
  order_id            text,
  fired_at            timestamptz not null default now(),
  winning_bracket     text,
  won                 boolean,
  pnl_usd             numeric(12,4),
  settled_at          timestamptz,
  unique (rule_id, city, local_date, bracket)       -- one filled buy per rule, city, day and bracket
);

create index if not exists automation_fills_fired_at_idx  on public.automation_fills (fired_at desc);
create index if not exists automation_fills_open_idx      on public.automation_fills (city, local_date) where won is null;
create index if not exists automation_fills_rule_idx      on public.automation_fills (rule_id);

create or replace function public.automation_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists automation_rules_touch on public.automation_rules;
create trigger automation_rules_touch before update on public.automation_rules
  for each row execute function public.automation_touch_updated_at();

alter table public.automation_rules enable row level security;
alter table public.automation_fills enable row level security;
