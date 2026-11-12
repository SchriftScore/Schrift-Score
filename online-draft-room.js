/* Schrift Score — Online Draft Room */
(function () {
  'use strict';
  var SUPABASE_URL = 'https://rwcalcmmrhcssjpkacts.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_sJriHLQFth-kYpO5hKU-wQ_p3xwV4GD';
  var client = null, roomId = null, roomCode = '', seat = null, hostId = null;
  var userId = null, playersInRoom = [], channel = null, botBusy = false, displayName = '';
  var isPublicRoom = false, publicStartTimer = null, publicStartRoomId = null;
  var modalId = 'sda-online-room';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function getPool() {
    try { return typeof getDraftPool === 'function' ? getDraftPool() : []; }
    catch (e) { return []; }
  }
  function ss(p) { return Number(p && p.total) || 0; }
  function roles(p) {
    var a = [];
    if ((+p.ppg || 0) >= 20) a.push('SCORING');
    if ((+p.apg || 0) >= 5) a.push('PLAYMAKING');
    if ((+p.spg || 0) >= 1.3 || (+p.bpg || 0) >= 1.2) a.push('DEFENSE');
    if ((+p.rpg || 0) >= 7.5) a.push('REBOUNDING');
    if ((+p.ppg || 0) >= 15 && (+p.rpg || 0) >= 5 && (+p.apg || 0) >= 4) a.push('ALL-AROUND');
    return a;
  }
  function teamScores(picks, pool) {
    return [0,1,2,3].map(function (s) {
      var roster = picks.filter(function (p) { return p.seat === s; }).map(function (pick) {
        return pool.find(function (p) { return p.name === pick.player_name; }) || {name:pick.player_name,total:0};
      });
      var covered = {};
      roster.forEach(function (p) { roles(p).forEach(function (r) { covered[r] = true; }); });
      var chemistry = Math.min(10, Object.keys(covered).length * 2);
      var base = roster.reduce(function (n,p) { return n + ss(p); }, 0);
      return {seat:s, roster:roster, base:base, chemistry:chemistry, total:base+chemistry};
    });
  }
  function turnAt(n) {
    var round = Math.floor(n / 4), slot = n % 4;
    return round % 2 === 0 ? slot : 3 - slot;
  }
  function ensureModal() {
    if (document.getElementById(modalId)) return;
    var m = document.createElement('div');
    m.id = modalId;
    m.className = 'hidden fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-md text-white';
    m.innerHTML = '<div class="h-full overflow-y-auto"><div class="max-w-5xl mx-auto p-4 sm:p-7"><header class="flex justify-between items-center border-b border-white/10 pb-4"><div><div class="text-[10px] uppercase tracking-[.25em] text-lime-300 font-black">Schrift Score</div><div class="text-2xl font-black">ONLINE DRAFT ROOM</div></div><button id="sda-online-close" class="border border-white/15 rounded-xl px-3 py-2 text-sm">✕ Close</button></header><div id="sda-online-content" class="py-5"></div></div></div>';
    document.body.appendChild(m);
    m.querySelector('#sda-online-close').addEventListener('click', close);
    m.addEventListener('click', function (e) {
      var b = e.target.closest('[data-online]');
      if (!b) return;
      var action = b.getAttribute('data-online');
      if (action === 'quick') quickMatch();
      if (action === 'create') createRoom();
      if (action === 'join') joinRoom();
      if (action === 'start') startRoom();
      if (action === 'leave') leaveRoom();
      if (action === 'pick') submitPick(b.getAttribute('data-player'));
      if (action === 'copy') copyCode();
    });
  }
  function open() {
    ensureModal();
    document.getElementById(modalId).classList.remove('hidden');
    renderHome();
  }
  function close() {
    var m = document.getElementById(modalId);
    if (m) m.classList.add('hidden');
    if (roomId) leaveRoom(false);
    else if (channel && client) { client.removeChannel(channel); channel = null; }
  }
  function setMessage(msg) {
    var n = document.getElementById('sda-online-message');
    if (n) n.textContent = msg;
    else alert(msg);
  }
  function renderHome(error) {
    document.getElementById('sda-online-content').innerHTML =
      '<section class="rounded-2xl border border-cyan-300/30 bg-gradient-to-r from-cyan-300/10 to-lime-300/5 p-5 mb-4"><div class="text-[10px] uppercase tracking-[.2em] text-cyan-200 font-black">Public matchmaking</div><div class="text-2xl font-black mt-1">QUICK MATCH</div><p class="text-sm text-slate-300 mt-1">Play against whoever is online. No invite code and no friends needed. We will find an open public draft or start one.</p><label class="block text-xs text-slate-400 mt-4 mb-1">Your display name</label><div class="flex flex-col sm:flex-row gap-2"><input id="sda-quick-name" maxlength="24" value="' + esc(displayName || 'Your Franchise') + '" class="flex-1 rounded-xl bg-slate-950 border border-white/15 px-3 py-3 text-sm"><button data-online="quick" class="rounded-xl bg-cyan-300 text-slate-950 font-black px-6 py-3">FIND A MATCH →</button></div></section>' +
      '<div class="grid md:grid-cols-2 gap-4">' +
      '<section class="rounded-2xl border border-lime-400/25 bg-slate-900 p-5"><div class="text-lg font-black">Create a private room</div><p class="text-sm text-slate-400 mt-1">Host a draft and invite friends with a six-character code.</p><label class="block text-xs text-slate-400 mt-5 mb-1">Your display name</label><input id="sda-online-name" maxlength="24" value="' + esc(displayName || 'Your Franchise') + '" class="w-full rounded-xl bg-slate-950 border border-white/15 px-3 py-3 text-sm"><button data-online="create" class="mt-3 w-full rounded-xl bg-lime-400 text-slate-950 font-black py-3">CREATE PRIVATE ROOM</button></section>' +
      '<section class="rounded-2xl border border-white/10 bg-slate-900 p-5"><div class="text-lg font-black">Join a private room</div><p class="text-sm text-slate-400 mt-1">Enter the code shared by the host.</p><label class="block text-xs text-slate-400 mt-5 mb-1">Your display name</label><input id="sda-online-join-name" maxlength="24" value="' + esc(displayName || 'Your Franchise') + '" class="w-full rounded-xl bg-slate-950 border border-white/15 px-3 py-3 text-sm"><label class="block text-xs text-slate-400 mt-3 mb-1">Room code</label><input id="sda-online-code" maxlength="6" placeholder="ABC123" class="w-full uppercase rounded-xl bg-slate-950 border border-white/15 px-3 py-3 text-sm tracking-[.25em]"><button data-online="join" class="mt-3 w-full rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200 font-black py-3">JOIN ROOM</button></section>' +
      '</div><p id="sda-online-message" class="text-sm text-rose-300 mt-4">' + esc(error || 'Sign-in is automatic. No password or account creation is needed.') + '</p><p class="text-[11px] text-slate-500 mt-4">Public matches start automatically once four players join, or after a short wait when at least two players are found. Empty seats are filled by the host AI.</p>';
  }
  async function ensureClient() {
    if (!client) {
      if (!window.supabase || !window.supabase.createClient) throw new Error('Supabase did not load. Refresh the page and try again.');
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    var session = await client.auth.getSession();
    if (session.error) throw session.error;
    if (!session.data.session) {
      var signed = await client.auth.signInAnonymously();
      if (signed.error) {
        if ((signed.error.message || '').toLowerCase().includes('anonymous')) {
          throw new Error('Enable Anonymous Sign-Ins in Supabase: Authentication → Sign In / Providers → Anonymous Sign-Ins.');
        }
        throw signed.error;
      }
      userId = signed.data.user.id;
    } else {
      var current = await client.auth.getUser();
      if (current.error) throw current.error;
      userId = current.data.user.id;
    }
  }
  async function quickMatch() {
    try {
      displayName = (document.getElementById('sda-quick-name').value || '').trim();
      if (!displayName) throw new Error('Enter a display name.');
      await ensureClient();
      setMessage('Finding players online…');
      var result = await client.rpc('quick_match_draft_room', {p_display_name:displayName});
      if (result.error) throw result.error;
      roomId = result.data.room_id; roomCode = result.data.room_code; seat = result.data.seat;
      isPublicRoom = true;
      await refreshRoom(); subscribe();
    } catch (e) { setMessage(e.message || String(e)); }
  }
  async function createRoom() {
    try {
      displayName = (document.getElementById('sda-online-name').value || '').trim();
      if (!displayName) throw new Error('Enter a display name.');
      await ensureClient();
      var result = await client.rpc('create_draft_room', {p_display_name:displayName});
      if (result.error) throw result.error;
      roomId = result.data.room_id; roomCode = result.data.room_code; seat = result.data.seat; isPublicRoom = false;
      await refreshRoom(); subscribe();
    } catch (e) { setMessage(e.message || String(e)); }
  }
  async function joinRoom() {
    try {
      displayName = (document.getElementById('sda-online-join-name').value || '').trim();
      var code = (document.getElementById('sda-online-code').value || '').trim().toUpperCase();
      if (!displayName || !code) throw new Error('Enter your name and room code.');
      await ensureClient();
      var result = await client.rpc('join_draft_room', {p_room_code:code,p_display_name:displayName});
      if (result.error) throw result.error;
      roomId = result.data.room_id; roomCode = result.data.room_code; seat = result.data.seat; isPublicRoom = false;
      await refreshRoom(); subscribe();
    } catch (e) { setMessage(e.message || String(e)); }
  }
  async function refreshRoom() {
    var roomResult = await client.from('draft_rooms').select('*').eq('id',roomId).single();
    if (roomResult.error) throw roomResult.error;
    var rosterResult = await client.from('draft_room_players').select('*').eq('room_id',roomId).order('seat');
    if (rosterResult.error) throw rosterResult.error;
    playersInRoom = rosterResult.data || [];
    hostId = roomResult.data.host_id;
    isPublicRoom = !!roomResult.data.is_public;
    renderRoom(roomResult.data);
    if (isPublicRoom) schedulePublicStart(roomResult.data);
  }
  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('ss-draft-' + roomId)
      .on('postgres_changes',{event:'*',schema:'public',table:'draft_rooms',filter:'id=eq.'+roomId},function(){refreshRoom().catch(function(e){setMessage(e.message);});})
      .on('postgres_changes',{event:'*',schema:'public',table:'draft_room_players',filter:'room_id=eq.'+roomId},function(){refreshRoom().catch(function(e){setMessage(e.message);});})
      .subscribe();
  }
  function renderRoom(r) {
    var host = userId === r.host_id;
    var seats = [0,1,2,3].map(function (s) {
      var p = playersInRoom.find(function (x) { return x.seat === s; });
      return '<div class="rounded-xl border ' + (p?'border-lime-400/30 bg-lime-400/5':'border-white/10 bg-slate-950/50') + ' p-4"><div class="text-[10px] uppercase text-slate-500">Seat ' + (s+1) + '</div><div class="font-black mt-1">' + (p?esc(p.display_name):'AI opponent if empty') + '</div>' + (s===seat?'<div class="text-[10px] text-lime-300 mt-1">YOU</div>':'') + '</div>';
    }).join('');
    var code = r.is_public
      ? '<div class="rounded-2xl border border-cyan-300/30 bg-cyan-300/5 p-5"><div class="text-xs uppercase tracking-widest text-cyan-200 font-bold">PUBLIC QUICK MATCH</div><div class="text-2xl font-black mt-2">You are in matchmaking</div><div class="text-xs text-slate-400 mt-2">You were matched with whoever was online. This lobby is not listed by room code.</div></div>'
      : '<div class="rounded-2xl border border-cyan-300/30 bg-cyan-300/5 p-5"><div class="text-xs uppercase tracking-widest text-cyan-200 font-bold">Invite friends · room code</div><div class="flex items-center gap-3 mt-2"><div class="text-4xl sm:text-5xl font-black tracking-[.2em]">' + esc(roomCode) + '</div><button data-online="copy" class="rounded-lg border border-white/20 px-3 py-2 text-xs">COPY</button></div><div class="text-xs text-slate-400 mt-2">Share this code with friends. Each person joins from their own device.</div></div>';
    var action = r.status === 'waiting'
      ? (r.is_public
          ? '<div class="w-full mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4 text-center"><div class="font-black text-cyan-200">WAITING FOR PLAYERS · '+playersInRoom.length+'/4</div><p class="text-xs text-slate-400 mt-1">'+(playersInRoom.length>=2?'Match found. Draft starts automatically in a moment.':'Keep this screen open. The draft starts when another player joins.')+'</p></div>'
          : (host ? '<button data-online="start" class="w-full mt-4 rounded-xl bg-lime-400 text-slate-950 font-black py-3" ' + (playersInRoom.length<2?'disabled style="opacity:.4"':'') + '>START DRAFT · ' + playersInRoom.length + '/4 PLAYERS</button>' : '<p class="text-sm text-slate-400 mt-4">Waiting for the host to start the draft…</p>'))
      : '<div class="mt-4 text-sm text-lime-200 font-bold">' + (r.status==='finished'?'Draft complete':'Draft in progress') + '</div>';
    document.getElementById('sda-online-content').innerHTML = code + '<div class="grid sm:grid-cols-2 gap-3 mt-4">' + seats + '</div>' + action + '<button data-online="leave" class="mt-3 text-xs text-slate-500 underline">Leave room</button><p id="sda-online-message" class="text-sm text-rose-300 mt-3"></p>' + (r.status==='waiting'?'':'<div id="sda-online-game" class="mt-5"></div>');
    if (r.status === 'live' || r.status === 'finished') renderGame(r);
  }
  function schedulePublicStart(r) {
    if (!r || !r.is_public || r.status !== 'waiting' || playersInRoom.length < 2) return;
    if (publicStartRoomId === r.id && publicStartTimer) return;
    if (publicStartTimer) clearTimeout(publicStartTimer);
    publicStartRoomId = r.id;
    var started = new Date(r.created_at).getTime() + 15000;
    var wait = Math.max(0, started - Date.now());
    publicStartTimer = setTimeout(async function () {
      publicStartTimer = null;
      try {
        var result = await client.rpc('start_public_draft_room', {p_room_id:r.id});
        if (result.error && !String(result.error.message || '').includes('Still looking')) {
          setMessage(result.error.message || String(result.error));
        }
        await refreshRoom();
      } catch (e) { setMessage(e.message || String(e)); }
    }, wait);
  }
  async function startRoom() {
    try { var result = await client.rpc('start_draft_room',{p_room_id:roomId}); if(result.error)throw result.error; await refreshRoom(); }
    catch(e){setMessage(e.message||String(e));}
  }
  async function submitPick(name) {
    try { var result = await client.rpc('submit_draft_pick',{p_room_id:roomId,p_player_name:name}); if(result.error)throw result.error; await refreshRoom(); }
    catch(e){setMessage(e.message||String(e));}
  }
  function renderGame(r) {
    var picks = (r.state && r.state.picks) || [];
    var turn = turnAt(picks.length);
    var myTurn = seat === turn;
    var host = userId === hostId;
    var vacant = !playersInRoom.some(function(p){return p.seat===turn;});
    var pool = getPool();
    var taken = picks.map(function(p){return p.player_name;});
    var available = pool.filter(function(p){return taken.indexOf(p.name)<0;});
    var teams = teamScores(picks,pool);
    var html = '<div class="rounded-2xl border border-white/10 bg-slate-900 p-4"><div class="flex justify-between items-center gap-2"><div><div class="text-[10px] uppercase tracking-widest text-cyan-200">Live draft · '+picks.length+'/20 picks</div><div class="text-2xl font-black mt-1">ROUND '+Math.min(5,Math.floor(picks.length/4)+1)+' / 5</div></div><div class="text-right text-xs font-bold '+(myTurn?'text-lime-200':'text-cyan-200')+'">'+(myTurn?'YOUR PICK':(host&&vacant?'HOST AI PICK':'SEAT '+(turn+1)+' ON THE CLOCK'))+'</div></div>';
    html += '<div class="grid sm:grid-cols-2 gap-2 mt-4">'+teams.map(function(t){var rp=playersInRoom.find(function(p){return p.seat===t.seat;});return '<div class="rounded-xl border border-white/10 bg-slate-950 p-3"><div class="flex justify-between"><b class="text-xs">'+esc(rp?rp.display_name:'AI · Seat '+(t.seat+1))+'</b><b class="text-cyan-200">'+t.total.toFixed(1)+'</b></div><div class="text-[9px] text-slate-500 mt-1">'+t.roster.map(function(p){return esc(p.name);}).join(' · ')+'</div><div class="text-[9px] text-lime-200 mt-1">+'+t.chemistry.toFixed(1)+' chemistry</div></div>';}).join('')+'</div>';
    html += '<div class="mt-4"><div class="text-xs font-black mb-2">PLAYER BOARD</div><input id="sda-online-search" placeholder="Search player" class="w-full rounded-lg bg-slate-950 border border-white/10 px-3 py-2 text-xs mb-2"><div class="max-h-72 overflow-y-auto divide-y divide-white/5">'+available.slice(0,80).map(function(p){var allowed=myTurn||(host&&vacant);return '<div class="flex items-center gap-3 py-2" data-player-row="'+esc(p.name.toLowerCase())+'"><div class="min-w-0 flex-1"><div class="text-xs font-bold">'+esc(p.name)+'</div><div class="text-[9px] text-slate-500">'+esc(p.team||'NBA')+'</div></div><b class="text-sm text-lime-200">'+ss(p).toFixed(1)+'</b><button data-online="pick" data-player="'+esc(p.name)+'" '+(!allowed?'disabled':'')+' class="rounded-lg bg-lime-400 px-3 py-2 text-[10px] font-black text-slate-950 disabled:opacity-30">PICK</button></div>';}).join('')+'</div></div>';
    html += '<p id="sda-online-message" class="text-sm text-rose-300 mt-3"></p><div class="text-[10px] text-slate-500 mt-2">Snake draft · Schrift Score totals + up to 10 chemistry points · Duplicate picks and out-of-turn picks are rejected by the database.</div></div>';
    var node = document.getElementById('sda-online-game');
    if (node) node.innerHTML = html;
    var search = document.getElementById('sda-online-search');
    if (search) search.addEventListener('input',function(){var q=this.value.toLowerCase();Array.from(node.querySelectorAll('[data-player-row]')).forEach(function(row){row.style.display=row.getAttribute('data-player-row').includes(q)?'flex':'none';});});
    if (host && vacant && r.status==='live' && picks.length<20 && !botBusy && available.length) {
      botBusy = true;
      setTimeout(function(){
        var result = client.rpc('submit_draft_pick',{p_room_id:roomId,p_player_name:available[0].name});
        result.then(function(res){botBusy=false;if(res.error)setMessage(res.error.message);else refreshRoom();}).catch(function(e){botBusy=false;setMessage(e.message);});
      },600);
    }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(roomCode); setMessage('Room code copied.'); }
    catch(e) { setMessage('Your room code is '+roomCode+'.'); }
  }
  async function leaveRoom(showHome) {
    var leavingId = roomId;
    if (channel && client) { client.removeChannel(channel); channel = null; }
    if (publicStartTimer) clearTimeout(publicStartTimer);
    publicStartTimer=null;publicStartRoomId=null;isPublicRoom=false;
    if (leavingId && client && userId) {
      try {
        var result = await client.rpc('leave_draft_room', {p_room_id:leavingId});
        if (result.error && showHome !== false) setMessage(result.error.message || String(result.error));
      } catch (e) {
        if (showHome !== false) setMessage(e.message || String(e));
      }
    }
    roomId=null;roomCode='';seat=null;hostId=null;playersInRoom=[];botBusy=false;
    if (showHome !== false) renderHome();
  }
  window.openOnlineDraftRoom = open;
})();