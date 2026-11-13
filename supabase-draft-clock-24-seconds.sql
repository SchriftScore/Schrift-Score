-- Schrift Score Draft Night: shared 24-second online clock and automatic timeout picks.
-- Run this entire migration in Supabase SQL Editor after the existing draft-room and quick-match SQL.
-- The database is authoritative: a client cannot auto-pick before the 24-second deadline.

update public.draft_rooms r
set state = jsonb_set(
  coalesce(r.state, '{}'::jsonb),
  '{turn_started_at}',
  to_jsonb(coalesce(
    nullif(r.state->>'turn_started_at','')::timestamptz,
    case
      when jsonb_array_length(coalesce(r.state->'picks','[]'::jsonb)) > 0
      then nullif(
        r.state->'picks'->(jsonb_array_length(coalesce(r.state->'picks','[]'::jsonb))-1)->>'picked_at',
        ''
      )::timestamptz
      else null
    end,
    nullif(r.state->>'started_at','')::timestamptz,
    r.created_at
  )),
  true
)
where r.status = 'live'
  and not (coalesce(r.state, '{}'::jsonb) ? 'turn_started_at');

create or replace function public.submit_draft_pick(p_room_id uuid, p_player_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.draft_rooms%rowtype;
  v_picks jsonb;
  v_count integer;
  v_round integer;
  v_slot integer;
  v_turn integer;
  v_user_seat integer;
  v_is_empty_seat boolean;
  v_turn_started timestamptz;
begin
  select * into v_room from public.draft_rooms where id = p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if v_room.status <> 'live' then raise exception 'Draft is not live.'; end if;
  if char_length(trim(p_player_name)) not between 1 and 100 then raise exception 'Invalid player name.'; end if;

  select seat into v_user_seat
  from public.draft_room_players
  where room_id = p_room_id and user_id = auth.uid();
  if v_user_seat is null then raise exception 'You are not in this room.'; end if;

  v_picks := coalesce(v_room.state->'picks', '[]'::jsonb);
  v_count := jsonb_array_length(v_picks);
  if v_count >= 20 then raise exception 'Draft is already complete.'; end if;
  if exists (select 1 from jsonb_array_elements(v_picks) p where p->>'player_name' = trim(p_player_name)) then
    raise exception 'That player has already been drafted.';
  end if;

  v_round := floor(v_count / 4.0)::integer;
  v_slot := v_count % 4;
  v_turn := case when v_round % 2 = 0 then v_slot else 3 - v_slot end;
  select not exists (
    select 1 from public.draft_room_players where room_id = p_room_id and seat = v_turn
  ) into v_is_empty_seat;

  -- A member may fill a vacant AI seat. An occupied seat can only pick for itself.
  if v_turn <> v_user_seat and not v_is_empty_seat then
    raise exception 'It is not your turn.';
  end if;
  if v_turn = v_user_seat then
    v_turn_started := coalesce(
      nullif(v_room.state->>'turn_started_at','')::timestamptz,
      case when v_count > 0 then nullif(v_picks->(v_count - 1)->>'picked_at','')::timestamptz else null end,
      nullif(v_room.state->>'started_at','')::timestamptz,
      v_room.created_at
    );
    if clock_timestamp() >= v_turn_started + interval '24 seconds' then
      raise exception 'The 24-second clock expired. An automatic pick is being processed.';
    end if;
  end if;

  v_picks := v_picks || jsonb_build_array(jsonb_build_object(
    'pick', v_count + 1,
    'round', v_round + 1,
    'seat', v_turn,
    'player_name', trim(p_player_name),
    'picked_by', auth.uid(),
    'picked_at', clock_timestamp(),
    'is_bot', (v_turn <> v_user_seat)
  ));

  update public.draft_rooms
  set state = jsonb_set(
        jsonb_set(coalesce(state, '{}'::jsonb), '{picks}', v_picks, true),
        '{turn_started_at}', to_jsonb(clock_timestamp()), true
      ),
      status = case when jsonb_array_length(v_picks) = 20 then 'finished' else 'live' end
  where id = p_room_id
  returning * into v_room;

  return jsonb_build_object('status', v_room.status, 'state', v_room.state);
end;
$$;

create or replace function public.auto_pick_draft_turn(p_room_id uuid, p_player_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.draft_rooms%rowtype;
  v_picks jsonb;
  v_count integer;
  v_round integer;
  v_slot integer;
  v_turn integer;
  v_user_seat integer;
  v_turn_started timestamptz;
begin
  select * into v_room from public.draft_rooms where id = p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if v_room.status <> 'live' then raise exception 'Draft is not live.'; end if;
  if auth.uid() is null then raise exception 'Sign in is required.'; end if;

  select seat into v_user_seat
  from public.draft_room_players
  where room_id = p_room_id and user_id = auth.uid();
  if v_user_seat is null then raise exception 'You are not in this room.'; end if;

  v_picks := coalesce(v_room.state->'picks', '[]'::jsonb);
  v_count := jsonb_array_length(v_picks);
  if v_count >= 20 then raise exception 'Draft is already complete.'; end if;
  if char_length(trim(p_player_name)) not between 1 and 100 then raise exception 'Invalid player name.'; end if;
  if exists (select 1 from jsonb_array_elements(v_picks) p where p->>'player_name' = trim(p_player_name)) then
    raise exception 'That player has already been drafted.';
  end if;

  v_turn_started := coalesce(
    nullif(v_room.state->>'turn_started_at','')::timestamptz,
    case when v_count > 0 then nullif(v_picks->(v_count - 1)->>'picked_at','')::timestamptz else null end,
    nullif(v_room.state->>'started_at','')::timestamptz,
    v_room.created_at
  );
  if clock_timestamp() < v_turn_started + interval '24 seconds' then
    raise exception 'The 24-second draft clock has not expired.';
  end if;

  v_round := floor(v_count / 4.0)::integer;
  v_slot := v_count % 4;
  v_turn := case when v_round % 2 = 0 then v_slot else 3 - v_slot end;

  v_picks := v_picks || jsonb_build_array(jsonb_build_object(
    'pick', v_count + 1,
    'round', v_round + 1,
    'seat', v_turn,
    'player_name', trim(p_player_name),
    'picked_by', auth.uid(),
    'picked_at', clock_timestamp(),
    'is_bot', true,
    'auto_reason', '24-second clock expired'
  ));

  update public.draft_rooms
  set state = jsonb_set(
        jsonb_set(coalesce(state, '{}'::jsonb), '{picks}', v_picks, true),
        '{turn_started_at}', to_jsonb(clock_timestamp()), true
      ),
      status = case when jsonb_array_length(v_picks) = 20 then 'finished' else 'live' end
  where id = p_room_id
  returning * into v_room;

  return jsonb_build_object('status', v_room.status, 'state', v_room.state);
end;
$$;

grant execute on function public.submit_draft_pick(uuid, text) to authenticated;
grant execute on function public.auto_pick_draft_turn(uuid, text) to authenticated;


-- Keep the authoritative deadline initialized whenever a room enters live status.
create or replace function public.start_draft_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.draft_rooms%rowtype;
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_room from public.draft_rooms where id = p_room_id for update;
  if not found then raise exception 'Room not found.'; end if;
  if v_room.host_id <> auth.uid() then raise exception 'Only the host can start the draft.'; end if;
  if v_room.status <> 'waiting' then raise exception 'Draft has already started.'; end if;
  select count(*) into v_count from public.draft_room_players where room_id = p_room_id;
  if v_count < 2 then raise exception 'At least two people must join before starting.'; end if;
  update public.draft_rooms
  set status = 'live',
      state = jsonb_build_object('picks','[]'::jsonb,'started_at',v_now,'turn_started_at',v_now)
  where id = p_room_id returning * into v_room;
  return jsonb_build_object('status', v_room.status, 'state', v_room.state);
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
  v_now timestamptz := clock_timestamp();
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
      state=jsonb_build_object('picks','[]'::jsonb,'started_at',v_now,'turn_started_at',v_now)
  where id=p_room_id
  returning * into v_room;
  return jsonb_build_object('status',v_room.status,'state',v_room.state);
end;
$$;

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
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then raise exception 'Sign in is required.'; end if;
  if char_length(trim(p_display_name)) not between 1 and 24 then
    raise exception 'Name must be 1–24 characters.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schrift-score-public-draft-matchmaking'));

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

  select r.* into v_room
  from public.draft_rooms r
  where r.is_public = true
    and r.status = 'waiting'
    and r.created_at > now() - interval '10 minutes'
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
  order by s limit 1;

  if v_seat is null then raise exception 'That match filled up. Tap Quick Match again.'; end if;

  insert into public.draft_room_players(room_id,user_id,seat,display_name)
  values (v_room.id,v_uid,v_seat,trim(p_display_name));

  select count(*) into v_count from public.draft_room_players where room_id = v_room.id;
  if v_count >= 4 then
    update public.draft_rooms
    set status='live',
        state=jsonb_build_object('picks','[]'::jsonb,'started_at',v_now,'turn_started_at',v_now)
    where id=v_room.id and status='waiting';
    v_room.status := 'live';
  end if;

  return jsonb_build_object('room_id',v_room.id,'room_code',v_room.room_code,'seat',v_seat,'status',v_room.status,'is_public',true);
end;
$$;

-- The timeout endpoint is a member-only RPC, never an anonymous public endpoint.
revoke all on function public.auto_pick_draft_turn(uuid, text) from public, anon;
grant execute on function public.auto_pick_draft_turn(uuid, text) to authenticated;
