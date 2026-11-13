-- Schrift Score Draft Room multiplayer schema
-- Run this entire file once in Supabase SQL Editor.

create table if not exists public.draft_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  host_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting','live','finished')),
  state jsonb not null default '{"picks":[]}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.draft_room_players (
  room_id uuid not null references public.draft_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat integer not null check (seat between 0 and 3),
  display_name text not null check (char_length(display_name) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, seat)
);

alter table public.draft_rooms enable row level security;
alter table public.draft_room_players enable row level security;

create or replace function public.is_draft_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (select 1 from public.draft_room_players
                 where room_id = p_room_id and user_id = auth.uid());
$$;

drop policy if exists "Room members can read their rooms" on public.draft_rooms;
create policy "Room members can read their rooms" on public.draft_rooms
for select to authenticated using (public.is_draft_room_member(id));

drop policy if exists "Players can read their room roster" on public.draft_room_players;
create policy "Players can read their room roster" on public.draft_room_players
for select to authenticated using (public.is_draft_room_member(room_id));

create or replace function public.create_draft_room(p_display_name text)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.draft_rooms%rowtype;
  v_code text;
begin
  if v_uid is null then raise exception 'Sign in is required.'; end if;
  if char_length(trim(p_display_name)) not between 1 and 24 then raise exception 'Name must be 1–24 characters.'; end if;
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.draft_rooms where room_code = v_code);
  end loop;
  insert into public.draft_rooms(room_code, host_id) values (v_code, v_uid) returning * into v_room;
  insert into public.draft_room_players(room_id, user_id, seat, display_name)
  values (v_room.id, v_uid, 0, trim(p_display_name));
  return jsonb_build_object('room_id', v_room.id, 'room_code', v_code, 'seat', 0);
end;
$$;

create or replace function public.join_draft_room(p_room_code text, p_display_name text)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.draft_rooms%rowtype;
  v_seat integer;
begin
  if v_uid is null then raise exception 'Sign in is required.'; end if;
  if char_length(trim(p_display_name)) not between 1 and 24 then raise exception 'Name must be 1–24 characters.'; end if;
  select * into v_room from public.draft_rooms where room_code = upper(trim(p_room_code)) for update;
  if not found then raise exception 'Room code not found.'; end if;
  if v_room.status <> 'waiting' then raise exception 'This draft has already started.'; end if;
  if exists (select 1 from public.draft_room_players where room_id = v_room.id and user_id = v_uid) then
    select seat into v_seat from public.draft_room_players where room_id = v_room.id and user_id = v_uid;
    return jsonb_build_object('room_id', v_room.id, 'room_code', v_room.room_code, 'seat', v_seat);
  end if;
  select s into v_seat from generate_series(0,3) s
  where not exists (select 1 from public.draft_room_players p where p.room_id = v_room.id and p.seat = s)
  order by s limit 1;
  if v_seat is null then raise exception 'This room is full.'; end if;
  insert into public.draft_room_players(room_id, user_id, seat, display_name)
  values (v_room.id, v_uid, v_seat, trim(p_display_name));
  return jsonb_build_object('room_id', v_room.id, 'room_code', v_room.room_code, 'seat', v_seat);
end;
$$;

create or replace function public.start_draft_room(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare v_room public.draft_rooms%rowtype; v_count integer;
begin
  select * into v_room from public.draft_rooms where id = p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if v_room.host_id <> auth.uid() then raise exception 'Only the host can start the draft.'; end if;
  if v_room.status <> 'waiting' then raise exception 'Draft has already started.'; end if;
  select count(*) into v_count from public.draft_room_players where room_id = p_room_id;
  if v_count < 2 then raise exception 'At least two people must join before starting.'; end if;
  update public.draft_rooms set status = 'live', state = jsonb_build_object('picks','[]'::jsonb,'started_at',now(),'turn_started_at',now())
  where id = p_room_id returning * into v_room;
  return jsonb_build_object('status', v_room.status, 'state', v_room.state);
end;
$$;

create or replace function public.submit_draft_pick(p_room_id uuid, p_player_name text)
returns jsonb language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.draft_rooms%rowtype;
  v_picks jsonb;
  v_count integer;
  v_round integer;
  v_slot integer;
  v_turn integer;
  v_user_seat integer;
  v_host uuid;
  v_is_empty_seat boolean;
begin
  select * into v_room from public.draft_rooms where id = p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if v_room.status <> 'live' then raise exception 'Draft is not live.'; end if;
  if char_length(trim(p_player_name)) not between 1 and 100 then raise exception 'Invalid player name.'; end if;
  select seat into v_user_seat from public.draft_room_players where room_id = p_room_id and user_id = auth.uid();
  if v_user_seat is null then raise exception 'You are not in this room.'; end if;
  v_picks := coalesce(v_room.state->'picks','[]'::jsonb);
  v_count := jsonb_array_length(v_picks);
  if v_count >= 20 then raise exception 'Draft is already complete.'; end if;
  if exists (select 1 from jsonb_array_elements(v_picks) p where p->>'player_name' = trim(p_player_name)) then
    raise exception 'That player has already been drafted.';
  end if;
  v_round := floor(v_count / 4.0)::integer;
  v_slot := v_count % 4;
  v_turn := case when v_round % 2 = 0 then v_slot else 3 - v_slot end;
  select not exists (select 1 from public.draft_room_players where room_id = p_room_id and seat = v_turn)
    into v_is_empty_seat;
  if v_turn <> v_user_seat and not (auth.uid() = v_room.host_id and v_is_empty_seat) then
    raise exception 'It is not your turn.';
  end if;
  v_picks := v_picks || jsonb_build_array(jsonb_build_object(
    'pick', v_count + 1, 'round', v_round + 1, 'seat', v_turn,
    'player_name', trim(p_player_name), 'picked_by', auth.uid(), 'picked_at', now(),
    'is_bot', (v_turn <> v_user_seat)
  ));
  update public.draft_rooms
  set state = jsonb_set(coalesce(state,'{}'::jsonb), '{picks}', v_picks, true),
      status = case when jsonb_array_length(v_picks) = 20 then 'finished' else 'live' end
  where id = p_room_id returning * into v_room;
  return jsonb_build_object('status', v_room.status, 'state', v_room.state);
end;
$$;

grant usage on schema public to authenticated;
grant select on public.draft_rooms, public.draft_room_players to authenticated;
grant execute on function public.create_draft_room(text) to authenticated;
grant execute on function public.join_draft_room(text,text) to authenticated;
grant execute on function public.start_draft_room(uuid) to authenticated;
grant execute on function public.submit_draft_pick(uuid,text) to authenticated;
grant execute on function public.is_draft_room_member(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.draft_rooms;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.draft_room_players;
exception when duplicate_object then null;
end $$;
