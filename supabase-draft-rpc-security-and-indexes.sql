-- Schrift Score Draft Night RPC permissions and supporting indexes.
-- Anonymous Auth users assume the authenticated Postgres role after signInAnonymously().

revoke all on function public.create_draft_room(text) from public, anon;
revoke all on function public.is_draft_room_member(uuid) from public, anon;
revoke all on function public.join_draft_room(text, text) from public, anon;
revoke all on function public.leave_draft_room(uuid) from public, anon;
revoke all on function public.quick_match_draft_room(text) from public, anon;
revoke all on function public.start_draft_room(uuid) from public, anon;
revoke all on function public.start_public_draft_room(uuid) from public, anon;
revoke all on function public.submit_draft_pick(uuid, text) from public, anon;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

grant execute on function public.create_draft_room(text) to authenticated;
grant execute on function public.is_draft_room_member(uuid) to authenticated;
grant execute on function public.join_draft_room(text, text) to authenticated;
grant execute on function public.leave_draft_room(uuid) to authenticated;
grant execute on function public.quick_match_draft_room(text) to authenticated;
grant execute on function public.start_draft_room(uuid) to authenticated;
grant execute on function public.start_public_draft_room(uuid) to authenticated;
grant execute on function public.submit_draft_pick(uuid, text) to authenticated;

create index if not exists draft_room_players_user_id_idx
  on public.draft_room_players(user_id);
create index if not exists draft_rooms_host_id_idx
  on public.draft_rooms(host_id);
create index if not exists draft_room_players_room_seat_idx
  on public.draft_room_players(room_id, seat);
