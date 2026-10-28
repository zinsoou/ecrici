-- Ecrici database. Paste this whole file in Supabase > SQL Editor > Run (once).

create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table if not exists public.shops (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null default '',
  phone      text not null default '',
  country    text not null default 'BJ',
  status     text not null default 'pending' check (status in ('pending','active','suspended')),
  paid_until date,
  created_at timestamptz not null default now()
);

create table if not exists public.ledgers (
  shop_id    uuid primary key references public.shops on delete cascade,
  data       jsonb not null,
  updated    bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.admins  enable row level security;
alter table public.shops   enable row level security;
alter table public.ledgers enable row level security;

-- helpers (security definer so they can read the tables the caller cannot)
create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.shop_ok(uid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shops
                 where id = uid and status = 'active'
                   and paid_until is not null and paid_until >= current_date)
$$;

-- a new account automatically gets a "pending" shop row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.shops (id, name, phone, country)
  values (new.id,
          left(coalesce(new.raw_user_meta_data->>'name',''), 80),
          left(coalesce(new.raw_user_meta_data->>'phone',''), 30),
          case when new.raw_user_meta_data->>'country' in ('BJ','NG','GH','KE')
               then new.raw_user_meta_data->>'country' else 'BJ' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- shops: a shop sees only its own row; only the admin can change status / dates
drop policy if exists shops_select on public.shops;
create policy shops_select on public.shops for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists shops_update on public.shops;
create policy shops_update on public.shops for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ledgers: read and write only your own, and only while approved and paid
drop policy if exists ledgers_select on public.ledgers;
create policy ledgers_select on public.ledgers for select to authenticated
  using (shop_id = auth.uid() and public.shop_ok(auth.uid()));

drop policy if exists ledgers_insert on public.ledgers;
create policy ledgers_insert on public.ledgers for insert to authenticated
  with check (shop_id = auth.uid() and public.shop_ok(auth.uid()));

drop policy if exists ledgers_update on public.ledgers;
create policy ledgers_update on public.ledgers for update to authenticated
  using (shop_id = auth.uid() and public.shop_ok(auth.uid()))
  with check (shop_id = auth.uid() and public.shop_ok(auth.uid()));

-- no one can reach the data without logging in
revoke all on public.shops, public.ledgers, public.admins from anon;
revoke all on public.admins from authenticated;
grant select, update on public.shops to authenticated;
grant select, insert, update on public.ledgers to authenticated;
