-- ============================================================================
-- DailyWater schema for Supabase project udclccwehhnhstngvgam
-- Paste into Dashboard -> SQL Editor -> Run:
--   https://supabase.com/dashboard/project/udclccwehhnhstngvgam/sql/new
--
-- Notes:
--  * All id / *Id columns are TEXT (app supplies its own ids via uid() =
--    Math.random().toString(36).slice(2,10); see app.js:417). A uuid PK with
--    gen_random_uuid() would reject every insert.
--  * camelCase columns are quoted to preserve the exact case the JS client sends.
--  * No Supabase Auth (custom phone+OTP). RLS is permissive (using(true)) for the
--    anon/publishable key, matching the rest of the app. Tighten to auth.uid()
--    when real Supabase Auth is added.
-- ============================================================================

-- users (upsert conflicts on PK id)
create table if not exists public.users (
  id text primary key, mobile text, name text, role text, address text,
  "dailyMl" numeric, plan text, frequency text, "assignedBoyId" text, photo text,
  password_hash text, "ownerId" text, status text, customer_limit integer,
  subscription_plan text, subscription_started_at timestamptz,
  subscription_expires_at timestamptz, created_at timestamptz default now());
alter table public.users enable row level security;
drop policy if exists "users anon full access" on public.users;
create policy "users anon full access" on public.users for all to anon, authenticated using (true) with check (true);
create index if not exists users_ownerid_idx on public.users ("ownerId");
create index if not exists users_role_idx on public.users (role);
create index if not exists users_mobile_idx on public.users (mobile);

-- deliveries (daily water-delivery log: one row per customer per day, ml = millilitres)
create table if not exists public.deliveries (
  id text primary key, "customerId" text, date date, status text,
  ml numeric default 0, photo text, "ownerId" text);
alter table public.deliveries enable row level security;
drop policy if exists "deliveries anon full access" on public.deliveries;
create policy "deliveries anon full access" on public.deliveries for all to anon, authenticated using (true) with check (true);
create index if not exists deliveries_ownerid_idx on public.deliveries ("ownerId");
create index if not exists deliveries_customerid_idx on public.deliveries ("customerId");
create index if not exists deliveries_date_idx on public.deliveries (date);

-- pauses
create table if not exists public.pauses (
  id text primary key, "customerId" text, "from" date, "to" date, "ownerId" text);
alter table public.pauses enable row level security;
drop policy if exists "pauses anon full access" on public.pauses;
create policy "pauses anon full access" on public.pauses for all to anon, authenticated using (true) with check (true);
create index if not exists pauses_ownerid_idx on public.pauses ("ownerId");
create index if not exists pauses_customerid_idx on public.pauses ("customerId");

-- extra_orders
create table if not exists public.extra_orders (
  id text primary key, "customerId" text, "productKey" text, qty numeric,
  date date, status text, "ownerId" text);
alter table public.extra_orders enable row level security;
drop policy if exists "extra_orders anon full access" on public.extra_orders;
create policy "extra_orders anon full access" on public.extra_orders for all to anon, authenticated using (true) with check (true);
create index if not exists extra_orders_ownerid_idx on public.extra_orders ("ownerId");
create index if not exists extra_orders_customerid_idx on public.extra_orders ("customerId");

-- payments
create table if not exists public.payments (
  id text primary key, "customerId" text, month text, amount numeric,
  date timestamptz, method text, "ownerId" text);
alter table public.payments enable row level security;
drop policy if exists "payments anon full access" on public.payments;
create policy "payments anon full access" on public.payments for all to anon, authenticated using (true) with check (true);
create index if not exists payments_ownerid_idx on public.payments ("ownerId");
create index if not exists payments_customerid_idx on public.payments ("customerId");

-- notifications
create table if not exists public.notifications (
  id text primary key, "userId" text, type text, title text, body text,
  date timestamptz, read boolean default false, "ownerId" text);
alter table public.notifications enable row level security;
drop policy if exists "notifications anon full access" on public.notifications;
create policy "notifications anon full access" on public.notifications for all to anon, authenticated using (true) with check (true);
create index if not exists notifications_ownerid_idx on public.notifications ("ownerId");
create index if not exists notifications_userid_idx on public.notifications ("userId");

-- holidays (upsert on ownerId,date)
create table if not exists public.holidays (
  id bigint generated always as identity primary key, date date, label text, "ownerId" text,
  constraint holidays_owner_date_uniq unique ("ownerId", date));
alter table public.holidays enable row level security;
drop policy if exists "holidays anon full access" on public.holidays;
create policy "holidays anon full access" on public.holidays for all to anon, authenticated using (true) with check (true);
create index if not exists holidays_ownerid_idx on public.holidays ("ownerId");

-- products (upsert on ownerId,key)
create table if not exists public.products (
  id bigint generated always as identity primary key, key text, name text, price numeric,
  emoji text, active boolean default true, stock numeric default 0, "ownerId" text,
  constraint products_owner_key_uniq unique ("ownerId", key));
alter table public.products enable row level security;
drop policy if exists "products anon full access" on public.products;
create policy "products anon full access" on public.products for all to anon, authenticated using (true) with check (true);
create index if not exists products_ownerid_idx on public.products ("ownerId");

-- product_ratings
create table if not exists public.product_ratings (
  id text primary key, "customerId" text, "productKey" text, "orderId" text,
  rating numeric, review text, date timestamptz, created_at timestamptz default now(), "ownerId" text);
alter table public.product_ratings enable row level security;
drop policy if exists "product_ratings anon full access" on public.product_ratings;
create policy "product_ratings anon full access" on public.product_ratings for all to anon, authenticated using (true) with check (true);
create index if not exists product_ratings_ownerid_idx on public.product_ratings ("ownerId");
create index if not exists product_ratings_customerid_idx on public.product_ratings ("customerId");

-- dairy_settings (one row per dairy, PK ownerId)
create table if not exists public.dairy_settings (
  "ownerId" text primary key, "pricePerLitre" numeric, "upiId" text, "upiName" text,
  "ownerWhatsApp" text, "businessName" text, "businessAddress" text,
  "businessPhone" text, language text default 'en');
alter table public.dairy_settings enable row level security;
drop policy if exists "dairy_settings anon full access" on public.dairy_settings;
create policy "dairy_settings anon full access" on public.dairy_settings for all to anon, authenticated using (true) with check (true);

-- subscription_plans (upsert conflicts on PK key)
create table if not exists public.subscription_plans (
  key text primary key, name text, price numeric, duration_days numeric,
  active boolean default true, sort_order numeric default 0);
alter table public.subscription_plans enable row level security;
drop policy if exists "subscription_plans anon full access" on public.subscription_plans;
create policy "subscription_plans anon full access" on public.subscription_plans for all to anon, authenticated using (true) with check (true);

-- subscription_payments (upsert conflicts on PK id)
create table if not exists public.subscription_payments (
  id text primary key, "ownerId" text, plan_key text, amount_paid numeric,
  paid_at timestamptz, expires_at timestamptz, marked_by_admin_id text, note text);
alter table public.subscription_payments enable row level security;
drop policy if exists "subscription_payments anon full access" on public.subscription_payments;
create policy "subscription_payments anon full access" on public.subscription_payments for all to anon, authenticated using (true) with check (true);
create index if not exists subscription_payments_ownerid_idx on public.subscription_payments ("ownerId");

-- device_tokens (upsert on userId,token)
create table if not exists public.device_tokens (
  id text primary key, "userId" text, token text, platform text,
  updated_at timestamptz default now(),
  constraint device_tokens_user_token_uniq unique ("userId", token));
alter table public.device_tokens enable row level security;
drop policy if exists "device_tokens anon full access" on public.device_tokens;
create policy "device_tokens anon full access" on public.device_tokens for all to anon, authenticated using (true) with check (true);
create index if not exists device_tokens_userid_idx on public.device_tokens ("userId");
