-- My finances — v1 schema
-- Plain PostgreSQL (>= 15). No vendor-specific features: runs locally, on Supabase, Neon, RDS, Railway, etc.
--
-- Multi-user
--   Every row belongs to a user (user_id). Isolation is enforced by the database, not the app:
--   1. user_id on every table, filled automatically from the session (app_user_id())
--   2. composite foreign keys (user_id, x_id) -> rows can only reference rows of the same user
--   3. row-level security (forced, also for the table owner) -> queries, views and functions only see the current user
--   The app runs as a non-superuser role and, per request/transaction:  set local app.user_id = '<uuid>';
--   With no user set, reads return nothing and writes fail (fail closed).
--   On Supabase, redefine app_user_id() to return auth.uid().
--
-- Layers
--   FACTS      what happened, never edited after import  (accounts, imports, transactions)
--   KNOWLEDGE  what the system has learned / been told    (categories, tags, merchants, merchant_rules, commitments, context_notes)
--   INSIGHTS   conclusions + your feedback on them        (anomalies, reviews) and derived views
--
-- Conventions
--   amount > 0 = money out (expense), amount < 0 = money in (refund, credit)
--   currency is 'UYU' or 'USD'; the two are never converted — every metric and forecast is per currency
--   source columns record who decided something: 'import' | 'claude' | 'user'

create extension if not exists pg_trgm;  -- fuzzy merchant matching

-- ============================================================
-- USERS
-- ============================================================

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- The current user for this session/transaction (null when not set)
create function app_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ============================================================
-- FACTS
-- ============================================================

create table accounts (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id               serial primary key,
  name             text not null,                        -- "Visa Itaú", "Débito BROU"
  kind             text not null check (kind in ('credit_card','debit_card','bank','cash','manual')),
  issuer           text,
  last4            text,
  external_ref     text,                                  -- issuer-side id, masked (last digits only)
  default_currency char(3) not null default 'UYU' check (default_currency in ('UYU','USD')),
  closing_day      smallint check (closing_day between 1 and 31),  -- card statement close
  due_day          smallint check (due_day between 1 and 31),      -- card payment due
  active           boolean not null default true,
  unique (user_id, id)
);

create table import_batches (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id           serial primary key,
  account_id   int not null,
  file_name    text not null,
  file_hash    text not null,                            -- same file never imported twice (per user)
  period_start date,
  period_end   date,
  row_count    int,
  imported_at  timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references accounts(user_id, id)
);

create table categories (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id        serial primary key,
  name      text not null,
  parent_id int,
  nature    text not null default 'variable' check (nature in ('fixed','variable','savings','income','excluded')),
  unique (user_id, id),
  foreign key (user_id, parent_id) references categories(user_id, id)
);

create table merchants (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id                  serial primary key,
  name                text not null,                     -- normalized: "Disco", "Netflix", "UTE"
  default_category_id int,
  notes               text,
  created_by          text not null default 'claude' check (created_by in ('claude','user')),
  unique (user_id, id),
  foreign key (user_id, default_category_id) references categories(user_id, id)
);

create table commitments (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id                 serial primary key,
  kind               text not null check (kind in ('installment_plan','subscription','bill','fixed','annual','loan')),
  loan_kind          text check (loan_kind in ('mortgage','personal','car','other')),
  description        text not null,
  merchant_id        int,
  account_id         int,
  category_id        int,
  currency           char(3) not null check (currency in ('UYU','USD')),
  expected_amount    numeric(14,2),                      -- per occurrence
  amount_tolerance   numeric(5,2) not null default 0.10, -- 10%: outside this => price_change anomaly
  every_n_months     smallint not null default 1,        -- 1 monthly, 12 annual
  expected_day       smallint check (expected_day between 1 and 31),
  start_date         date not null,
  installments_total smallint,                           -- installment_plan: cuotas; loan: term in months
  principal          numeric(14,2),                      -- loan only
  annual_rate        numeric(7,4),                       -- loan only, % per year (e.g. 8.5)
  off_statement      boolean not null default false,     -- paid outside the imported exports (rent in cash, bank debit not imported)
  end_date           date,                               -- null = open-ended
  status             text not null default 'active' check (status in ('active','ended','cancelled')),
  detected_by        text not null default 'claude' check (detected_by in ('claude','user')),
  confirmed          boolean not null default false,     -- user validated it
  notes              text,
  check (kind not in ('installment_plan','loan') or installments_total is not null),
  check (kind <> 'loan' or (principal is not null and annual_rate is not null and loan_kind is not null)),
  unique (user_id, id),
  foreign key (user_id, merchant_id) references merchants(user_id, id),
  foreign key (user_id, account_id) references accounts(user_id, id),
  foreign key (user_id, category_id) references categories(user_id, id)
);

create table transactions (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id                 bigserial primary key,
  account_id         int not null,
  import_batch_id    int,
  raw                jsonb,                              -- original row, untouched
  posted_on          date not null,                      -- date on the export (purchase date for card cuotas)
  period_month       date not null,                      -- accounting month: statement month for cards, posted month otherwise
  description_raw    text not null,
  amount             numeric(14,2) not null,
  currency           char(3) not null check (currency in ('UYU','USD')),
  kind               text not null default 'purchase'
                     check (kind in ('purchase','refund','fee','interest','tax','loan_payment','cash_withdrawal','card_payment','transfer','income','fx')),
  merchant_id        int,
  category_id        int,
  categorized_by     text check (categorized_by in ('rule','claude','user')),
  installment_number smallint,
  installment_total  smallint,
  commitment_id      int,
  fingerprint        text not null,                      -- dedupe across overlapping exports (per user)
  note               text,
  review_reason      text,                               -- set by the importer when unsure; cleared once the user answers
  created_at         timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, account_id) references accounts(user_id, id),
  foreign key (user_id, import_batch_id) references import_batches(user_id, id),
  foreign key (user_id, merchant_id) references merchants(user_id, id),
  foreign key (user_id, category_id) references categories(user_id, id),
  foreign key (user_id, commitment_id) references commitments(user_id, id)
);
create index on transactions (user_id, posted_on);
create index on transactions (user_id, period_month);
create index on transactions (user_id, merchant_id);
create index on transactions (user_id, category_id);
create index on transactions (user_id, commitment_id);
create index transactions_desc_trgm on transactions using gin (description_raw gin_trgm_ops);

-- ============================================================
-- KNOWLEDGE
-- ============================================================

-- Learned matching rules: raw description -> merchant (and optionally category/kind).
-- Every correction you make becomes a row here, so the same question is never asked twice.
create table merchant_rules (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id          serial primary key,
  pattern     text not null,
  match_type  text not null check (match_type in ('exact','prefix','contains','regex')),
  account_id  int,               -- null = any account
  merchant_id int not null,
  category_id int,            -- overrides merchant default
  kind        text,                                      -- e.g. force 'card_payment'
  amount_min  numeric(14,2),                             -- optional amount range (same merchant, different meaning by amount)
  amount_max  numeric(14,2),
  priority    smallint not null default 100,             -- lower wins
  source      text not null check (source in ('claude','user')),
  hits        int not null default 0,
  created_at  timestamptz not null default now(),
  unique nulls not distinct (user_id, pattern, match_type, account_id, amount_min, amount_max),
  unique (user_id, id),
  foreign key (user_id, account_id) references accounts(user_id, id),
  foreign key (user_id, merchant_id) references merchants(user_id, id),
  foreign key (user_id, category_id) references categories(user_id, id)
);

-- Things you tell the system that numbers alone can't explain:
-- "trip to Brazil in Jan", "the 40k at the hardware store was the driveway, one-off", "Netflix is shared".
create table context_notes (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id              serial primary key,
  kind            text not null check (kind in ('event','one_off','plan','fact')),
  title           text not null,
  body            text,
  starts_on       date,
  ends_on         date,
  amount_estimate numeric(14,2),
  currency        char(3) check (currency in ('UYU','USD')),
  transaction_id  bigint,
  merchant_id     int,
  category_id     int,
  created_at      timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, transaction_id) references transactions(user_id, id),
  foreign key (user_id, merchant_id) references merchants(user_id, id),
  foreign key (user_id, category_id) references categories(user_id, id)
);

-- Tags: what an expense was FOR (car1, car2, house, trip-brasil), orthogonal to category (what it WAS).
-- A transaction can have several tags. Tags can nest: car1 and car2 under "cars" roll up automatically.
create table tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id        serial primary key,
  name      text not null check (name = lower(name) and name !~ '\s'),  -- lowercase, no spaces
  parent_id int,
  archived  boolean not null default false,             -- e.g. a car you sold: kept for history, hidden from pickers
  notes     text,
  unique (user_id, id),
  foreign key (user_id, parent_id) references tags(user_id, id)
);

create table transaction_tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  transaction_id bigint not null,
  tag_id         int not null,
  tagged_by      text not null default 'user' check (tagged_by in ('rule','commitment','merchant','claude','user')),
  primary key (transaction_id, tag_id),
  foreign key (user_id, transaction_id) references transactions(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references tags(user_id, id)
);
create index on transaction_tags (user_id, tag_id);

create table commitment_tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  commitment_id int not null,
  tag_id        int not null,
  primary key (commitment_id, tag_id),
  foreign key (user_id, commitment_id) references commitments(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references tags(user_id, id)
);

create table context_note_tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  context_note_id int not null,
  tag_id          int not null,
  primary key (context_note_id, tag_id),
  foreign key (user_id, context_note_id) references context_notes(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references tags(user_id, id)
);

-- Default tags for a merchant (e.g. the mechanic you only use for car1)
create table merchant_tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  merchant_id int not null,
  tag_id      int not null,
  primary key (merchant_id, tag_id),
  foreign key (user_id, merchant_id) references merchants(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references tags(user_id, id)
);

-- Tags a learned rule applies (e.g. "ANCAP" on the card you use for car2 -> car2)
create table merchant_rule_tags (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  merchant_rule_id int not null,
  tag_id           int not null,
  primary key (merchant_rule_id, tag_id),
  foreign key (user_id, merchant_rule_id) references merchant_rules(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references tags(user_id, id)
);


-- ============================================================
-- INSIGHTS (persisted because your feedback on them is knowledge too)
-- ============================================================

create table anomalies (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id             bigserial primary key,
  kind           text not null check (kind in
                 ('duplicate','unusual_amount','new_merchant','price_change','missed_charge',
                  'fx_fee','category_spike','unexpected_installment')),
  severity       text not null default 'info' check (severity in ('info','warn','alert')),
  transaction_id bigint,
  commitment_id  int,
  category_id    int,
  period         date,                                   -- month it refers to (first day)
  explanation    text not null,                          -- human-readable "why this was flagged"
  status         text not null default 'open' check (status in ('open','confirmed','dismissed')),
  resolution     text,                                   -- your answer; dismissals teach future runs
  detected_at    timestamptz not null default now(),
  resolved_at    timestamptz,
  unique (user_id, id),
  foreign key (user_id, transaction_id) references transactions(user_id, id),
  foreign key (user_id, commitment_id) references commitments(user_id, id),
  foreign key (user_id, category_id) references categories(user_id, id)
);
create unique index anomalies_dedupe on anomalies (user_id, kind, coalesce(transaction_id,0), coalesce(commitment_id,0), coalesce(period,'1900-01-01'));

create table reviews (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id         serial primary key,
  period     date not null,                              -- first day of reviewed month
  summary_md text not null,                              -- the narrative monthly review
  created_at timestamptz not null default now(),
  unique (user_id, id)
);

-- ============================================================
-- DERIVED VIEWS
-- ============================================================

-- Transactions that count as spending (shared by metrics, baseline, forecast accuracy)
create view v_spend_tx with (security_invoker = true) as
select t.*, c.nature
from transactions t
left join categories c on c.id = t.category_id
where t.kind in ('purchase','refund','fee','interest','tax','loan_payment','cash_withdrawal')
  and coalesce(c.nature, 'variable') not in ('excluded','income','savings');

-- Spend per month, category and currency (native amounts, no conversion)
create view v_monthly_spend with (security_invoker = true) as
select t.period_month as month,
       coalesce(c.name, '(uncategorized)')    as category,
       coalesce(t.nature, 'variable')         as nature,
       t.currency,
       sum(t.amount)                          as amount,
       count(*)                               as tx_count
from v_spend_tx t
left join categories c on c.id = t.category_id
group by 1, 2, 3, 4;

-- Each tag mapped to itself and all its ancestors (car1 -> car1, cars)
create view v_tag_ancestors with (security_invoker = true) as
with recursive t(tag_id, ancestor_id, depth) as (
  select id, id, 0 from tags
  union all
  select t.tag_id, p.parent_id, t.depth + 1
  from t join tags p on p.id = t.ancestor_id
  where p.parent_id is not null
)
select t.tag_id, t.ancestor_id, a.name as ancestor, t.depth from t join tags a on a.id = t.ancestor_id;

-- Direct tag names per transaction, sorted (used as a grouping key)
create view v_tx_tag_set with (security_invoker = true) as
select tt.transaction_id, array_agg(g.name order by g.name) as tags
from transaction_tags tt join tags g on g.id = tt.tag_id
group by tt.transaction_id;

-- Spend per month, tag (with roll-up to parent tags), category and currency.
-- A transaction with two tags counts in both, so tag totals can overlap; currency totals never double count.
create view v_tag_spend with (security_invoker = true) as
select t.period_month as month,
       a.ancestor                              as tag,
       coalesce(c.name, '(uncategorized)')     as category,
       t.currency,
       sum(t.amount)                           as amount,
       count(distinct t.id)                    as tx_count
from v_spend_tx t
-- distinct: a transaction tagged both "nivus" and "autos" counts once under "autos"
join (select distinct tt.transaction_id, a.ancestor
      from transaction_tags tt join v_tag_ancestors a on a.tag_id = tt.tag_id) a on a.transaction_id = t.id
left join categories c on c.id = t.category_id
group by 1, 2, 3, 4;

-- Last month a commitment can occur in (null = open-ended)
create view v_commitment_bounds with (security_invoker = true) as
select c.*,
       date_trunc('month', c.start_date)::date as first_month,
       coalesce(date_trunc('month', c.end_date),
                case when c.kind in ('installment_plan','loan')
                     then date_trunc('month', c.start_date) + (c.installments_total - 1) * interval '1 month' end
       )::date as last_month
from commitments c
where c.status = 'active';

-- Expected future charges from active commitments (current month + next 11).
-- The series is anchored at the start month, so annual/periodic items land on their real month.
create view v_commitment_schedule with (security_invoker = true) as
select b.id as commitment_id, b.kind, b.description, b.currency, b.expected_amount,
       gs::date as due_month,
       case when b.kind in ('installment_plan','loan')
            then ((extract(year from gs) - extract(year from b.first_month)) * 12
                + extract(month from gs) - extract(month from b.first_month))::int + 1
       end as installment_number
from v_commitment_bounds b
cross join lateral generate_series(
  b.first_month,
  least(date_trunc('month', current_date) + interval '11 months',
        coalesce(b.last_month, date_trunc('month', current_date) + interval '11 months')),
  make_interval(months => b.every_n_months)
) gs
where gs >= date_trunc('month', current_date);

-- Past occurrences with no matching transaction (missed_charge candidates)
create view v_commitment_gaps with (security_invoker = true) as
select b.id as commitment_id, b.description, gs::date as due_month
from v_commitment_bounds b
cross join lateral generate_series(
  b.first_month,
  least(date_trunc('month', current_date) - interval '1 month',
        coalesce(b.last_month, date_trunc('month', current_date) - interval '1 month')),
  make_interval(months => b.every_n_months)
) gs
where not exists (
  select 1 from transactions t
  where t.commitment_id = b.id
    and t.period_month = gs
);

-- ============================================================
-- FORECAST (per currency: UYU and USD, never mixed)
--
--   forecast = commitments due that month          (known: cuotas, subscriptions, bills, annual items)
--            + variable baseline per category       (last N complete months, excluding commitment-linked
--                                                    charges and transactions marked one_off)
--            + planned events from context_notes    (trip, purchase, anything told in advance)
--
--   Each line has low / expected / high, so the totals are a range with reasons, not a single number.
-- ============================================================

-- Variable spending baseline per category, currency and tag set.
-- Window: the p_lookback complete months before p_month (or before the current month if p_month is in the future).
-- Months with no spend count as 0, so rare categories don't get inflated.
-- Grouping by tag set keeps "Fuel for car1" and "Fuel for car2" as separate lines.
create function f_baseline(p_month date, p_lookback int default 3)
returns table (category_id int, currency char(3), tags text[], low numeric, expected numeric, high numeric,
               months_with_spend int, months_of_data int)
language sql stable as $$
  with bounds as (
    select least(date_trunc('month', p_month), date_trunc('month', current_date))::date as anchor
  ),
  -- only months with imported data count: one month of history must not be averaged over three
  months as (
    select g.month::date as month
    from bounds,
         generate_series(anchor - make_interval(months => p_lookback),
                         anchor - interval '1 month', interval '1 month') as g(month)
    where exists (select 1 from transactions t where t.period_month = g.month::date and t.import_batch_id is not null)
  ),
  per_month as (
    select t.period_month as month, t.category_id, t.currency,
           coalesce(ts.tags, '{}') as tags, sum(t.amount) as amount
    from v_spend_tx t
    cross join bounds
    left join v_tx_tag_set ts on ts.transaction_id = t.id
    where t.commitment_id is null
      and t.period_month >= (select min(month) from months)
      and t.period_month <  bounds.anchor
      and not exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)
    group by 1, 2, 3, 4
  ),
  keys as (select distinct category_id, currency, tags from per_month),
  grid as (
    select k.category_id, k.currency, k.tags, m.month, coalesce(p.amount, 0) as amount
    from keys k
    cross join months m
    left join per_month p
      on p.category_id is not distinct from k.category_id and p.currency = k.currency
     and p.tags = k.tags and p.month = m.month
  )
  select category_id, currency, tags,
         round(min(amount), 2), round(avg(amount), 2), round(max(amount), 2),
         (count(*) filter (where amount <> 0))::int,
         (select count(*) from months)::int
  from grid
  group by category_id, currency, tags
$$;

-- Forecast line items for one month. tags = direct tags of the line (roll-ups happen in f_forecast_by_tag).
create function f_forecast(p_month date, p_lookback int default 3)
returns table (component text, ref_id bigint, label text, category text, tags text[], currency char(3),
               low numeric, expected numeric, high numeric, basis text)
language sql stable as $$
  with m as (select date_trunc('month', p_month)::date as month)
  -- 1. commitments due in the month
  select 'commitment', b.id::bigint, b.description, c.name,
         coalesce((select array_agg(g.name order by g.name) from commitment_tags ct join tags g on g.id = ct.tag_id
                   where ct.commitment_id = b.id), '{}'),
         b.currency,
         round(b.expected_amount * (1 - b.amount_tolerance), 2),
         b.expected_amount,
         round(b.expected_amount * (1 + b.amount_tolerance), 2),
         coalesce(b.loan_kind || ' ', '') || b.kind || case when b.kind in ('installment_plan','loan')
                        then ' ' || (((extract(year from m.month) - extract(year from b.first_month)) * 12
                                     + extract(month from m.month) - extract(month from b.first_month))::int + 1)
                             || '/' || b.installments_total
                        else '' end
         || case when b.off_statement then ' · off-statement' else '' end
         || case when b.confirmed then '' else ' (unconfirmed)' end
  from v_commitment_bounds b
  cross join m
  left join categories c on c.id = b.category_id
  where m.month >= b.first_month
    and (b.last_month is null or m.month <= b.last_month)
    and ((extract(year from m.month) - extract(year from b.first_month)) * 12
         + extract(month from m.month) - extract(month from b.first_month))::int % b.every_n_months = 0
  union all
  -- 2. variable baseline
  select 'baseline', bl.category_id::bigint,
         coalesce(c.name, '(uncategorized)') || case when bl.tags <> '{}' then ' · ' || array_to_string(bl.tags, ', ') else '' end,
         coalesce(c.name, '(uncategorized)'), bl.tags,
         bl.currency, bl.low, bl.expected, bl.high,
         bl.months_of_data || '-month average, spent in ' || bl.months_with_spend || ' of ' || bl.months_of_data || ' months'
  from f_baseline(p_month, p_lookback) bl
  left join categories c on c.id = bl.category_id
  where bl.expected <> 0
  union all
  -- 3. planned events (amount split evenly across the months they span)
  select 'event', n.id::bigint, n.title, c.name,
         coalesce((select array_agg(g.name order by g.name) from context_note_tags nt join tags g on g.id = nt.tag_id
                   where nt.context_note_id = n.id), '{}'),
         n.currency,
         round(n.amount_estimate / span.months, 2), round(n.amount_estimate / span.months, 2),
         round(n.amount_estimate / span.months, 2),
         n.kind || case when span.months > 1 then ' (1/' || span.months || ' of total)' else '' end
  from context_notes n
  cross join m
  left join categories c on c.id = n.category_id
  cross join lateral (
    select ((extract(year from coalesce(n.ends_on, n.starts_on)) - extract(year from n.starts_on)) * 12
          + extract(month from coalesce(n.ends_on, n.starts_on)) - extract(month from n.starts_on))::int + 1 as months
  ) span
  where n.kind in ('event','plan')
    and n.amount_estimate is not null and n.currency is not null and n.starts_on is not null
    and m.month between date_trunc('month', n.starts_on) and date_trunc('month', coalesce(n.ends_on, n.starts_on))
$$;

-- Forecast totals per currency for one month
create function f_forecast_totals(p_month date, p_lookback int default 3)
returns table (currency char(3), committed numeric, variable numeric, events numeric,
               low numeric, expected numeric, high numeric)
language sql stable as $$
  -- The variable part's range comes from real month totals (lowest and highest month in the window),
  -- not from adding each category's own min/max: categories don't all peak in the same month.
  with lines as (select * from f_forecast(p_month, p_lookback)),
  bounds as (
    select least(date_trunc('month', p_month), date_trunc('month', current_date))::date as anchor
  ),
  months as (
    select g.month::date as month
    from bounds,
         generate_series(anchor - make_interval(months => p_lookback), anchor - interval '1 month', interval '1 month') as g(month)
    where exists (select 1 from transactions t where t.period_month = g.month::date and t.import_batch_id is not null)
  ),
  variable_months as (
    select m.month, c.currency,
           coalesce((select sum(t.amount) from v_spend_tx t
                     where t.period_month = m.month and t.currency = c.currency and t.commitment_id is null
                       and not exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)), 0) as amount
    from months m cross join (select distinct currency from lines) c
  ),
  variable_range as (
    select currency, min(amount) as low, max(amount) as high from variable_months group by currency
  )
  select l.currency,
         coalesce(sum(l.expected) filter (where l.component = 'commitment'), 0),
         coalesce(sum(l.expected) filter (where l.component = 'baseline'), 0),
         coalesce(sum(l.expected) filter (where l.component = 'event'), 0),
         coalesce(sum(l.low) filter (where l.component <> 'baseline'), 0) + coalesce(min(v.low), 0),
         sum(l.expected),
         coalesce(sum(l.high) filter (where l.component <> 'baseline'), 0) + coalesce(max(v.high), 0)
  from lines l
  left join variable_range v on v.currency = l.currency
  group by l.currency
  order by l.currency desc
$$;

-- Forecast per tag and currency for one month (with roll-up to parent tags, e.g. "cars" = car1 + car2)
create function f_forecast_by_tag(p_month date, p_lookback int default 3)
returns table (tag text, currency char(3), committed numeric, variable numeric, events numeric,
               low numeric, expected numeric, high numeric)
language sql stable as $$
  select distinct_lines.tag, distinct_lines.currency,
         coalesce(sum(expected) filter (where component = 'commitment'), 0),
         coalesce(sum(expected) filter (where component = 'baseline'), 0),
         coalesce(sum(expected) filter (where component = 'event'), 0),
         sum(low), sum(expected), sum(high)
  from (
    -- one row per (line, tag incl. ancestors); distinct so a line tagged car1 and cars isn't counted twice in "cars"
    select distinct f.component, f.ref_id, f.label, f.currency, f.low, f.expected, f.high, a.ancestor as tag
    from f_forecast(p_month, p_lookback) f
    cross join lateral unnest(f.tags) as u(name)
    join tags g on g.name = u.name
    join v_tag_ancestors a on a.tag_id = g.id
  ) distinct_lines
  group by distinct_lines.tag, distinct_lines.currency
  order by distinct_lines.tag, distinct_lines.currency desc
$$;

-- Snapshots of issued forecasts, so each month can be compared with what actually happened
create table forecast_snapshots (
  user_id            uuid not null default app_user_id() references users(id) on delete cascade,
  id           bigserial primary key,
  target_month date not null,
  component    text not null,
  ref_id       bigint,
  label        text not null,
  category     text,
  tags         text[] not null default '{}',
  currency     char(3) not null check (currency in ('UYU','USD')),
  low          numeric(14,2),
  expected     numeric(14,2),
  high         numeric(14,2),
  basis        text,
  created_at   timestamptz not null default now(),
  unique (user_id, id)
);
create index on forecast_snapshots (user_id, target_month);

-- Save the current forecast for a month (replaces any earlier snapshot for that month)
create function f_snapshot_forecast(p_month date, p_lookback int default 3)
returns int language plpgsql as $$
declare n int;
begin
  delete from forecast_snapshots where target_month = date_trunc('month', p_month);
  insert into forecast_snapshots (target_month, component, ref_id, label, category, tags, currency, low, expected, high, basis)
  select date_trunc('month', p_month), * from f_forecast(p_month, p_lookback);
  get diagnostics n = row_count;
  return n;
end $$;

-- Forecast vs actual per month and currency (for snapshotted months).
-- actual_one_off = spend you marked as one_off: a miss it explains is not a model error.
create view v_forecast_accuracy with (security_invoker = true) as
with f as (
  select target_month as month, currency, sum(low) as low, sum(expected) as expected, sum(high) as high
  from forecast_snapshots group by 1, 2
),
a as (
  select t.period_month as month, t.currency,
         sum(t.amount) as actual,
         coalesce(sum(t.amount) filter (where exists (
           select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)), 0) as actual_one_off
  from v_spend_tx t group by 1, 2
)
select f.month, f.currency, f.low, f.expected, f.high,
       coalesce(a.actual, 0)         as actual,
       coalesce(a.actual_one_off, 0) as actual_one_off,
       coalesce(a.actual, 0) - f.expected as diff,
       coalesce(a.actual, 0) - coalesce(a.actual_one_off, 0) - f.expected as diff_excl_one_off,
       round(100 * (coalesce(a.actual, 0) - coalesce(a.actual_one_off, 0) - f.expected) / nullif(f.expected, 0), 1) as diff_excl_one_off_pct,
       coalesce(a.actual, 0) - coalesce(a.actual_one_off, 0) between f.low and f.high as within_range
from f left join a using (month, currency);

-- ============================================================
-- EASY ENTRY: fixed expenses, loans, mortgages
-- ============================================================

-- Tag by name, created if missing; optional parent ("cars")
create function f_tag_id(p_name text, p_parent text default null)
returns int language plpgsql as $$
declare v int; v_parent int;
begin
  if p_name is null then return null; end if;
  if p_parent is not null then v_parent := f_tag_id(p_parent); end if;
  select id into v from tags where name = lower(trim(p_name));
  if v is null then
    insert into tags (name, parent_id) values (lower(trim(p_name)), v_parent) returning id into v;
  elsif v_parent is not null then
    update tags set parent_id = v_parent where id = v and parent_id is distinct from v_parent;
  end if;
  return v;
end $$;

-- tag_transactions(array[101,102], 'car1')  — tag one or many transactions by hand
create function tag_transactions(p_ids bigint[], variadic p_tags text[])
returns int language sql as $$
  with ins as (
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select i, f_tag_id(t), 'user' from unnest(p_ids) i, unnest(p_tags) t
    on conflict do nothing
    returning 1
  ) select count(*)::int from ins
$$;

-- tag_commitment(3, 'house')  — future occurrences in the forecast and posted payments inherit it
create function tag_commitment(p_commitment_id int, variadic p_tags text[])
returns int language sql as $$
  with ins as (
    insert into commitment_tags (commitment_id, tag_id)
    select p_commitment_id, f_tag_id(t) from unnest(p_tags) t
    on conflict do nothing
    returning 1
  ), back as (   -- also tag already-recorded payments of that commitment
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select tr.id, f_tag_id(t), 'commitment'
    from transactions tr, unnest(p_tags) t
    where tr.commitment_id = p_commitment_id
    on conflict do nothing
  ) select count(*)::int from ins
$$;

-- Category by name, created if missing
create function f_category_id(p_name text, p_nature text default 'fixed')
returns int language plpgsql as $$
declare v int;
begin
  if p_name is null then return null; end if;
  select id into v from categories where lower(name) = lower(p_name);
  if v is null then
    insert into categories (name, nature) values (p_name, p_nature) returning id into v;
  end if;
  return v;
end $$;

-- Merchant by name, created if missing; sets its default category when given
create function f_merchant_id(p_name text, p_category_id int default null)
returns int language plpgsql as $$
declare v int;
begin
  if p_name is null then return null; end if;
  select id into v from merchants where lower(name) = lower(trim(p_name));
  if v is null then
    insert into merchants (name, default_category_id, created_by) values (trim(p_name), p_category_id, 'user') returning id into v;
  elsif p_category_id is not null then
    update merchants set default_category_id = p_category_id where id = v;
  end if;
  return v;
end $$;

-- Monthly payment of a fixed-rate (French) loan
create function f_loan_payment(p_principal numeric, p_annual_rate numeric, p_months int)
returns numeric language sql immutable as $$
  select round(case when p_annual_rate = 0 then p_principal / p_months
                    else p_principal * (p_annual_rate / 1200)
                         / (1 - power(1 + p_annual_rate / 1200, -p_months)) end, 2)
$$;

-- add_fixed_expense('Alquiler', 25000, 'UYU', 'Vivienda', p_day => 5)
create function add_fixed_expense(
  p_description    text,
  p_amount         numeric,
  p_currency       char(3),
  p_category       text     default null,
  p_day            int      default null,
  p_start          date     default date_trunc('month', current_date)::date,
  p_end            date     default null,
  p_every_n_months int      default 1,      -- 12 for yearly, 2 for bimonthly...
  p_off_statement  boolean  default true,   -- true when it won't show up in imported exports
  p_tags           text[]   default '{}',   -- e.g. array['house']
  p_merchant       text     default null,   -- imported payments to this merchant are linked to the commitment
  p_tolerance      numeric  default 0.05    -- allowed variation before a price_change anomaly (0.05 = 5%)
) returns int language sql as $$
  with c as (
  insert into commitments (kind, description, merchant_id, category_id, currency, expected_amount, amount_tolerance,
                           every_n_months, expected_day, start_date, end_date, off_statement, detected_by, confirmed)
  values (case when p_every_n_months >= 12 then 'annual' else 'fixed' end,
          p_description, f_merchant_id(p_merchant), f_category_id(p_category), p_currency, p_amount, p_tolerance,
          p_every_n_months, p_day, p_start, p_end, p_off_statement, 'user', true)
  returning id
  ), t as (
    insert into commitment_tags (commitment_id, tag_id)
    select c.id, f_tag_id(x) from c, unnest(p_tags) x
  )
  select id from c
$$;

-- add_loan('Hipoteca BHU', 'mortgage', 3500000, 'UYU', 8.5, 240, '2024-03-01', p_day => 10)
-- Payment is computed (French amortization) unless p_payment is given (e.g. when the bank adds insurance).
create function add_loan(
  p_description   text,
  p_loan_kind     text,      -- mortgage | personal | car | other
  p_principal     numeric,
  p_currency      char(3),
  p_annual_rate   numeric,   -- % per year
  p_term_months   int,
  p_first_payment date,
  p_payment       numeric  default null,
  p_category      text     default 'Deudas',
  p_day           int      default null,
  p_off_statement boolean  default true,
  p_tags          text[]   default '{}'
) returns int language sql as $$
  with c as (
  insert into commitments (kind, loan_kind, description, category_id, currency, principal, annual_rate,
                           installments_total, expected_amount, amount_tolerance, expected_day, start_date,
                           off_statement, detected_by, confirmed)
  values ('loan', p_loan_kind, p_description, f_category_id(p_category), p_currency, p_principal, p_annual_rate,
          p_term_months, coalesce(p_payment, f_loan_payment(p_principal, p_annual_rate, p_term_months)), 0.02,
          p_day, p_first_payment, p_off_statement, 'user', true)
  returning id
  ), t as (
    insert into commitment_tags (commitment_id, tag_id)
    select c.id, f_tag_id(x) from c, unnest(p_tags) x
  )
  select id from c
$$;

-- Record off-statement commitments as transactions for a month (idempotent).
-- Run once per month; edit the amount afterwards if the real payment differed.
create function f_post_off_statement(p_month date)
returns int language plpgsql as $$
declare v_account int; n int;
begin
  insert into accounts (name, kind) values ('Manual', 'manual') on conflict (user_id, name) do nothing;
  select id into v_account from accounts where name = 'Manual';
  insert into transactions (account_id, posted_on, description_raw, amount, currency, kind,
                            category_id, categorized_by, commitment_id, installment_number,
                            installment_total, fingerprint)
  select v_account,
         (date_trunc('month', p_month) + make_interval(days => least(coalesce(b.expected_day, 1),
            extract(day from date_trunc('month', p_month) + interval '1 month - 1 day')::int) - 1))::date,
         b.description, b.expected_amount, b.currency,
         case when b.kind = 'loan' then 'loan_payment' else 'purchase' end,
         b.category_id, 'user', b.id,
         case when b.kind in ('installment_plan','loan')
              then ((extract(year from p_month) - extract(year from b.first_month)) * 12
                  + extract(month from p_month) - extract(month from b.first_month))::int + 1 end,
         b.installments_total,
         'manual:' || b.id || ':' || to_char(p_month, 'YYYY-MM')
  from v_commitment_bounds b
  where b.off_statement
    and date_trunc('month', p_month) >= b.first_month
    and (b.last_month is null or date_trunc('month', p_month) <= b.last_month)
    and ((extract(year from p_month) - extract(year from b.first_month)) * 12
         + extract(month from p_month) - extract(month from b.first_month))::int % b.every_n_months = 0
  on conflict (user_id, fingerprint) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Debt overview: where each loan stands today
create view v_loan_status with (security_invoker = true) as
with l as (
  select b.*,
         greatest(0, least(b.installments_total,
           ((extract(year from current_date) - extract(year from b.first_month)) * 12
            + extract(month from current_date) - extract(month from b.first_month))::int
           + case when extract(day from current_date) >= coalesce(b.expected_day, 1) then 1 else 0 end
         )) as paid,
         b.annual_rate / 1200 as r
  from v_commitment_bounds b
  where b.kind = 'loan'
)
select id as commitment_id, description, loan_kind, currency, principal, annual_rate,
       expected_amount as monthly_payment,
       paid as payments_made, installments_total - paid as payments_left,
       last_month as last_payment_month,
       round(case when r = 0 then principal - expected_amount * paid
                  else principal * power(1 + r, paid) - expected_amount * (power(1 + r, paid) - 1) / r end, 2)
         as balance_estimate,
       round(expected_amount * (installments_total - paid)
             - case when r = 0 then principal - expected_amount * paid
                    else principal * power(1 + r, paid) - expected_amount * (power(1 + r, paid) - 1) / r end, 2)
         as interest_left_estimate
from l;

-- ============================================================
-- AUTO-TAGGING: a transaction inherits tags from its commitment and its merchant
-- (rule tags are applied by the import pipeline, since it knows which rule matched)
-- ============================================================
create function trg_inherit_tags() returns trigger language plpgsql as $$
begin
  if new.commitment_id is not null then
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select new.id, ct.tag_id, 'commitment' from commitment_tags ct
    where ct.commitment_id = new.commitment_id and ct.user_id = new.user_id
    on conflict do nothing;
  end if;
  if new.merchant_id is not null then
    insert into transaction_tags (transaction_id, tag_id, tagged_by)
    select new.id, mt.tag_id, 'merchant' from merchant_tags mt
    where mt.merchant_id = new.merchant_id and mt.user_id = new.user_id
    on conflict do nothing;
  end if;
  return null;
end $$;

create trigger transactions_inherit_tags
after insert or update of commitment_id, merchant_id on transactions
for each row execute function trg_inherit_tags();


-- Names and dedupe keys are unique per user, not globally
alter table accounts       add unique (user_id, name);
alter table import_batches add unique (user_id, file_hash);
alter table categories     add unique (user_id, name);
alter table merchants      add unique (user_id, name);
alter table transactions   add unique (user_id, fingerprint);
alter table tags           add unique (user_id, name);
alter table reviews        add unique (user_id, period);

-- ============================================================
-- ROW-LEVEL SECURITY
-- Forced, so it applies to the table owner too. Superusers still bypass it: never run the app as one.
-- ============================================================

alter table users enable row level security;
alter table users force row level security;
create policy users_self on users using (id = app_user_id()) with check (id = app_user_id());

alter table accounts enable row level security;
alter table accounts force row level security;
create policy tenant on accounts using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table import_batches enable row level security;
alter table import_batches force row level security;
create policy tenant on import_batches using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table categories enable row level security;
alter table categories force row level security;
create policy tenant on categories using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table merchants enable row level security;
alter table merchants force row level security;
create policy tenant on merchants using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table commitments enable row level security;
alter table commitments force row level security;
create policy tenant on commitments using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table transactions enable row level security;
alter table transactions force row level security;
create policy tenant on transactions using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table merchant_rules enable row level security;
alter table merchant_rules force row level security;
create policy tenant on merchant_rules using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table context_notes enable row level security;
alter table context_notes force row level security;
create policy tenant on context_notes using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table tags enable row level security;
alter table tags force row level security;
create policy tenant on tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table transaction_tags enable row level security;
alter table transaction_tags force row level security;
create policy tenant on transaction_tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table commitment_tags enable row level security;
alter table commitment_tags force row level security;
create policy tenant on commitment_tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table context_note_tags enable row level security;
alter table context_note_tags force row level security;
create policy tenant on context_note_tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table merchant_tags enable row level security;
alter table merchant_tags force row level security;
create policy tenant on merchant_tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table merchant_rule_tags enable row level security;
alter table merchant_rule_tags force row level security;
create policy tenant on merchant_rule_tags using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table anomalies enable row level security;
alter table anomalies force row level security;
create policy tenant on anomalies using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table reviews enable row level security;
alter table reviews force row level security;
create policy tenant on reviews using (user_id = app_user_id()) with check (user_id = app_user_id());

alter table forecast_snapshots enable row level security;
alter table forecast_snapshots force row level security;
create policy tenant on forecast_snapshots using (user_id = app_user_id()) with check (user_id = app_user_id());


-- Application role (no superuser, no bypassrls). Create users through a privileged/service connection.
-- create role finance_app login password '...';
-- grant usage on schema public to finance_app;
-- grant select, insert, update, delete on all tables in schema public to finance_app;
-- grant usage on all sequences in schema public to finance_app;
-- grant execute on all functions in schema public to finance_app;

-- ============================================================
-- period_month defaults to the posted month (importers set it explicitly for card statements)
-- ============================================================
create function trg_period_month() returns trigger language plpgsql as $$
begin
  new.period_month := date_trunc('month', coalesce(new.period_month, new.posted_on))::date;
  return new;
end $$;

create trigger transactions_period_month
before insert or update of posted_on, period_month on transactions
for each row execute function trg_period_month();

-- ============================================================
-- LEARNING: every answer the user gives becomes knowledge that also applies to the past
-- ============================================================

-- Same matching semantics as the importer (src/importer.ts: ruleMatches)
create function f_rule_matches(p_match_type text, p_pattern text, p_text text)
returns boolean language sql immutable as $$
  select case p_match_type
    when 'exact'    then lower(p_text) = lower(p_pattern)
    when 'prefix'   then left(lower(p_text), length(p_pattern)) = lower(p_pattern)
    when 'contains' then position(lower(p_pattern) in lower(p_text)) > 0
    when 'regex'    then p_text ~* p_pattern
  end
$$;

-- Link unlinked payments to the active recurring commitment of the same merchant and currency.
-- Linked payments count as "committed" in the forecast and leave the variable baseline.
create function link_commitments()
returns int language plpgsql as $$
-- Each payment links to at most one commitment, and each commitment takes at most one payment per month:
-- per (commitment, month) the closest amount wins; the rest stay unlinked (they show up as variable spend,
-- which is where an unexpected extra charge belongs). Repeats until nothing changes, so a payment that
-- lost to a closer one can still take the next free commitment (e.g. installment 2 of the same insurer).
declare n int; total int := 0;
begin
  loop
    with eligible as (
      select t.id as tx_id, c.id as commitment_id, t.period_month,
             abs(t.amount - coalesce(c.expected_amount, t.amount)) as diff
      from transactions t
      join commitments c
        on c.merchant_id = t.merchant_id and c.currency = t.currency
       and c.status = 'active' and c.kind <> 'installment_plan'
       and t.period_month >= date_trunc('month', c.start_date)
       and (c.end_date is null or t.period_month <= c.end_date)
       -- only in months the commitment is actually due (annual, every 36 months, ...)
       and ((extract(year from t.period_month) - extract(year from c.start_date)) * 12
            + extract(month from t.period_month) - extract(month from c.start_date))::int % c.every_n_months = 0
      where t.commitment_id is null and t.merchant_id is not null
        and t.kind in ('purchase','loan_payment','tax','fee')
        and not exists (select 1 from transactions o where o.commitment_id = c.id and o.period_month = t.period_month)
    ),
    best_per_tx as (
      select distinct on (tx_id) * from eligible order by tx_id, diff, commitment_id
    ),
    best_per_slot as (
      select distinct on (commitment_id, period_month) * from best_per_tx order by commitment_id, period_month, diff, tx_id
    )
    update transactions t set commitment_id = b.commitment_id
      from best_per_slot b where t.id = b.tx_id;
    get diagnostics n = row_count;
    exit when n = 0;
    total := total + n;
  end loop;
  return total;
end $$;

-- learn_merchant('GASTOS COMUNES', 'Gastos comunes', 'Gastos comunes', 'fixed', p_tags => array['apartment'])
-- Creates/updates category, merchant (+ default tags) and a matching rule, then applies it to every
-- existing transaction that matches (clearing their review flag). Future imports apply the rule.
-- Returns how many existing transactions were updated.
create function learn_merchant(
  p_pattern    text,
  p_merchant   text,
  p_category   text    default null,
  p_nature     text    default 'variable',  -- fixed | variable | savings | income | excluded
  p_kind       text    default null,        -- force a kind (e.g. 'transfer'); null keeps what the importer decided
  p_tags       text[]  default '{}',
  p_match_type text    default 'contains',
  p_account_id int     default null,        -- restrict to one account (e.g. fuel on the card used for car2)
  p_priority   int     default 100,
  p_amount_min numeric default null,        -- restrict to an amount range (e.g. the ~4,000 patente is the BYD)
  p_amount_max numeric default null
) returns int language plpgsql as $$
declare v_cat int; v_merchant int; v_rule int; n int;
begin
  v_cat := f_category_id(p_category, p_nature);
  v_merchant := f_merchant_id(p_merchant, v_cat);
  insert into merchant_tags (merchant_id, tag_id) select v_merchant, f_tag_id(t) from unnest(p_tags) t on conflict do nothing;

  delete from merchant_rules
   where pattern = p_pattern and match_type = p_match_type and account_id is not distinct from p_account_id
     and amount_min is not distinct from p_amount_min and amount_max is not distinct from p_amount_max;
  insert into merchant_rules (pattern, match_type, account_id, merchant_id, category_id, kind, priority, source, amount_min, amount_max)
  values (p_pattern, p_match_type, p_account_id, v_merchant, v_cat, p_kind, p_priority, 'user', p_amount_min, p_amount_max)
  returning id into v_rule;

  update transactions t
     set merchant_id = v_merchant,          -- trigger adds the merchant's tags
         category_id = coalesce(v_cat, t.category_id),
         kind = coalesce(p_kind, t.kind),
         categorized_by = 'user',
         review_reason = null
   where f_rule_matches(p_match_type, p_pattern, t.description_raw)
     and (p_account_id is null or t.account_id = p_account_id)
     and (p_amount_min is null or t.amount >= p_amount_min)
     and (p_amount_max is null or t.amount <= p_amount_max);
  get diagnostics n = row_count;
  update merchant_rules set hits = n where id = v_rule;

  perform link_commitments();
  return n;
end $$;

-- resolve_transaction(123, 'Varios', p_note => 'casual expense')
-- Answer for one transaction only (no rule): category, kind, tags, note; optionally mark it one-off so
-- it stays out of the variable baseline.
create function resolve_transaction(
  p_id       bigint,
  p_category text    default null,
  p_nature   text    default 'variable',
  p_kind     text    default null,
  p_tags     text[]  default '{}',
  p_note     text    default null,
  p_one_off  boolean default false
) returns void language plpgsql as $$
begin
  update transactions
     set category_id = coalesce(f_category_id(p_category, p_nature), category_id),
         kind = coalesce(p_kind, kind),
         categorized_by = 'user',
         review_reason = null,
         note = coalesce(p_note, note)
   where id = p_id;
  if not found then raise exception 'transaction % not found', p_id; end if;
  insert into transaction_tags (transaction_id, tag_id, tagged_by)
  select p_id, f_tag_id(t), 'user' from unnest(p_tags) t on conflict do nothing;
  if p_one_off then
    insert into context_notes (kind, title, transaction_id)
    select 'one_off', coalesce(p_note, description_raw), id from transactions where id = p_id;
  end if;
end $$;

-- ============================================================
-- RECURRING DETECTION: candidates for commitments, found in the last 12 months of imported data
-- Claude reviews these with the user; confirmed ones become commitments (add_fixed_expense / learn_merchant).
-- ============================================================
create view v_recurring_candidates with (security_invoker = true) as
with tx as (
  select coalesce(m.name, t.raw->>'merchantHint') as merchant, t.currency, t.period_month, t.amount
  from v_spend_tx t
  left join merchants m on m.id = t.merchant_id
  where t.commitment_id is null
    and t.kind in ('purchase','tax','loan_payment','fee')
    and t.period_month >= date_trunc('month', current_date) - interval '12 months'
    and not exists (select 1 from context_notes n where n.kind = 'one_off' and n.transaction_id = t.id)
),
per_month as (
  select merchant, currency, period_month, sum(amount) as amount, count(*) as charges
  from tx where merchant is not null
  group by 1, 2, 3
),
gaps as (
  select p.*,
         ((extract(year from period_month) * 12 + extract(month from period_month))
          - lag(extract(year from period_month) * 12 + extract(month from period_month))
              over (partition by merchant, currency order by period_month))::int as gap
  from per_month p
),
agg as (
  select merchant, currency,
         count(*)::int                                                               as months_seen,
         min(period_month)                                                           as first_month,
         max(period_month)                                                           as last_month,
         (percentile_cont(0.5) within group (order by gap) filter (where gap is not null))::int as cadence_months,
         round((percentile_cont(0.5) within group (order by amount))::numeric, 2)   as typical_amount,
         min(amount)                                                                 as min_amount,
         max(amount)                                                                 as max_amount,
         round((stddev_pop(amount) / nullif(avg(amount), 0))::numeric, 2)           as variation,
         round(avg(charges), 1)                                                      as charges_per_month
  from gaps
  group by merchant, currency
),
latest as (
  select max(period_month) as month from transactions where import_batch_id is not null
),
-- months with imported data: a merchant can only be expected in months we actually have
coverage as (
  select distinct period_month as month from transactions where import_batch_id is not null
)
select a.merchant, a.currency, a.months_seen, a.first_month, a.last_month,
       case a.cadence_months when 1 then 'monthly' when 2 then 'every 2 months' when 3 then 'quarterly'
                             when 4 then 'every 4 months' when 6 then 'twice a year'
                             else 'every ' || a.cadence_months || ' months' end    as cadence,
       a.cadence_months, a.typical_amount, a.min_amount, a.max_amount, a.variation, a.charges_per_month,
       case when a.variation <= 0.05 then 'fixed amount'
            when a.variation <= 0.35 then 'varies (bill-like)'
            else 'irregular amount' end                                             as amount_pattern,
       a.last_month >= l.month - make_interval(months => a.cadence_months)          as still_active,
       exists (select 1 from commitments c join merchants m on m.id = c.merchant_id
               where lower(m.name) = lower(a.merchant) and c.currency = a.currency and c.status = 'active') as has_commitment
from agg a cross join latest l
where a.months_seen >= 3
  and a.cadence_months between 1 and 6
  -- regular: seen in at least 75% of the slots its cadence predicts between first and last sighting,
  -- counting only months that have imported data
  and a.months_seen >= 0.75 * (
        select count(*) from coverage cv
        where cv.month between a.first_month and a.last_month
          and ((extract(year from cv.month) - extract(year from a.first_month)) * 12
               + extract(month from cv.month) - extract(month from a.first_month))::int % a.cadence_months = 0)
order by a.currency desc, a.typical_amount desc;
