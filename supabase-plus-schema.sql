-- Schrift Score Plus subscription schema.
-- This schema is private: browser clients cannot read or modify subscription records.
create schema if not exists private;
create table if not exists private.schrift_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'inactive'
    check (status in ('active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused','inactive')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create table if not exists private.schrift_stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
alter table private.schrift_subscriptions enable row level security;
alter table private.schrift_stripe_events enable row level security;
revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on private.schrift_subscriptions to service_role;
grant select, insert, update, delete on private.schrift_stripe_events to service_role;
create or replace function public.schrift_get_subscription(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$ select to_jsonb(s) from private.schrift_subscriptions s where s.user_id = p_user_id $$;
create or replace function public.schrift_upsert_subscription(
  p_user_id uuid,p_customer_id text,p_subscription_id text,p_price_id text,p_status text,
  p_current_period_end timestamptz,p_cancel_at_period_end boolean
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.schrift_subscriptions(user_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,current_period_end,cancel_at_period_end,updated_at)
  values(p_user_id,p_customer_id,p_subscription_id,p_price_id,p_status,p_current_period_end,coalesce(p_cancel_at_period_end,false),now())
  on conflict(user_id) do update set stripe_customer_id=excluded.stripe_customer_id,
    stripe_subscription_id=excluded.stripe_subscription_id,stripe_price_id=excluded.stripe_price_id,
    status=excluded.status,current_period_end=excluded.current_period_end,
    cancel_at_period_end=excluded.cancel_at_period_end,updated_at=now();
end $$;
create or replace function public.schrift_record_stripe_event(p_event_id text,p_event_type text)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.schrift_stripe_events(event_id,event_type) values(p_event_id,p_event_type)
  on conflict(event_id) do nothing;
  return found;
end $$;
create or replace function public.schrift_find_user_by_customer(p_customer_id text)
returns uuid language sql stable security definer set search_path = ''
as $$ select s.user_id from private.schrift_subscriptions s where s.stripe_customer_id=p_customer_id limit 1 $$;
revoke all on function public.schrift_get_subscription(uuid) from public,anon,authenticated;
revoke all on function public.schrift_upsert_subscription(uuid,text,text,text,text,timestamptz,boolean) from public,anon,authenticated;
revoke all on function public.schrift_record_stripe_event(text,text) from public,anon,authenticated;
revoke all on function public.schrift_find_user_by_customer(text) from public,anon,authenticated;
grant execute on function public.schrift_get_subscription(uuid) to service_role;
grant execute on function public.schrift_upsert_subscription(uuid,text,text,text,text,timestamptz,boolean) to service_role;
grant execute on function public.schrift_record_stripe_event(text,text) to service_role;
grant execute on function public.schrift_find_user_by_customer(text) to service_role;
