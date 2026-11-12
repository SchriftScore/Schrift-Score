-- Public Quick Match for Schrift Score Draft Night
-- Run once in Supabase SQL Editor after supabase-draft-room.sql.

alter table public.draft_rooms
  add column if not exists is_public boolean not null default false;

create index if not exists draft_rooms_public_waiting_idx
  on public.draft_rooms (created_at)
  where is_public = true and status = 'waiting';

create or replace function public.quick_match_draft_room(p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.draft_rooms%rowtype;
  v_seat integer;
  v_count integer;
  v_code text;
begin
  if v_uid is null then raise exception 'Sign in is required.'; end if;
  if char_length(trim(p_display_name)) not between 1 and 24 then
    raise exception 'Name must be 1–24 characters.';
  end if;

  -- Serialize matchmaking so two users cannot claim the same final seat.
  perform pg_advisory_xact_lock(hashtext('schrift-score-public-draft-matchmaking'));

  -- Reuse this user's existing public waiting room if they refresh.
  select r.* into v_room
  from public.draft_rooms r
  join public.draft_room_players p on p.room_id = r.id
  where p.user_id = v_uid and r.is_public = true and r.status = 'waiting'
  order by r.created_at desc
  limit 1
  for update of r;

  if found then
    select seat into v_seat from public.draft_room_players
    where room_id = v_room.id and user_id = v_uid;
    return jsonb_build_object('room_id',v_room.id,'room_code',v_room.room_code,'seat',v_seat,'status',v_room.status,'is_public',true);
  end if;

  -- Match into a recently-created public room with an open seat.
  select r.* into v_room
  from public.draft_rooms r
  where r.is_public = true
    and r.status = 'waiting'
    and r.created_at > now() - interval '2 minutes'
    and not exists (
      select 1 from public.draft_room_players p
      where p.room_id = r.id and p.user_id = v_uid
    )
    and (select count(*) from public.draft_room_players p where p.room_id = r.id) < 4
  order by r.created_at asc
  limit 1
  for update;

  if not found then
    loop
      v_code := upper(substr(md5(random()::text || clock_timestamp()::text),1,6));
      exit when not exists (select 1 from public.draft_rooms where room_code = v_code);
    end loop;
    insert into public.draft_rooms(room_code,host_id,is_public)
    values (v_code,v_uid,true)
    returning * into v_room;
    insert into public.draft_room_players(room_id,user_id,seat,display_name)
    values (v_room.id,v_uid,0,trim(p_display_name));
    return jsonb_build_object('room_id',v_room.id,'room_code',v_code,'seat',0,'status','waiting','is_public',true);
  end if;

  select s into v_seat
  from generate_series(0,3) s
  where not exists (
    select 1 from public.draft_room_players p
    where p.room_id = v_room.id and p.seat = s
  )
  order by s
  limit 1;

  if v_seat is null then raise exception 'That match filled up. Tap Quick Match again.'; end if;

  insert into public.draft_room_players(room_id,user_id,seat,display_name)
  values (v_room.id,v_uid,v_seat,trim(p_display_name));

  select count(*) into v_count from public.draft_room_players where room_id = v_room.id;
  if v_count >= 4 then
    update public.draft_rooms
    set status='live',
        state=jsonb_build_object('picks','[]'::jsonb,'started_at',now())
    where id=v_room.id and status='waiting';
    v_room.status := 'live';
  end if;

  return jsonb_build_object('room_id',v_room.id,'room_code',v_room.room_code,'seat',v_seat,'status',v_room.status,'is_public',true);
end;
$$;

create or replace function public.start_public_draft_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.draft_rooms%rowtype;
  v_count integer;
begin
  select * into v_room from public.draft_rooms where id=p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if not exists (
    select 1 from public.draft_room_players
    where room_id=p_room_id and user_id=auth.uid()
  ) then raise exception 'You are not in this match.'; end if;
  if not v_room.is_public then raise exception 'This is not a public match.'; end if;
  if v_room.status <> 'waiting' then
    return jsonb_build_object('status',v_room.status,'state',v_room.state);
  end if;
  select count(*) into v_count from public.draft_room_players where room_id=p_room_id;
  if v_count < 2 then raise exception 'Still looking for another player.'; end if;
  if v_room.created_at > now() - interval '15 seconds' and v_count < 4 then
    raise exception 'Matchmaking is still collecting players.';
  end if;
  update public.draft_rooms
  set status='live',
      state=jsonb_build_object('picks','[]'::jsonb,'started_at',now())
  where id=p_room_id
  returning * into v_room;
  return jsonb_build_object('status',v_room.status,'state',v_room.state);
end;
$$;

grant execute on function public.quick_match_draft_room(text) to authenticated;
grant execute on function public.start_public_draft_room(uuid) to authenticated;
