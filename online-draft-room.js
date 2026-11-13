/* Schrift Score — Online Draft Room */
(function () {
  'use strict';
  var SUPABASE_URL = 'https://rwcalcmmrhcssjpkacts.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_sJriHLQFth-kYpO5hKU-wQ_p3xwV4GD';
  var client = null, roomId = null, roomCode = '', seat = null, hostId = null;
  var userId = null, playersInRoom = [], channel = null, botBusy = false, displayName = '';
  var isPublicRoom = false, publicStartTimer = null, publicStartRoomId = null;
  var selectedPlayer = null, turnClockTimer = null, turnClockKey = '', turnStartedAt = 0, autoPickBusy = false;
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
  var challenges = [
    {name:'GET TO THE LINE',tag:'Rim pressure',desc:'Reward players who attack the basket and get to the free-throw line.',label:'PTS',bonus:function(p){return Math.min((+p.ppg||0)*0.18,5.5);}},
    {name:'TABLE SETTERS',tag:'Playmaking',desc:'Find the creators who generate good looks for teammates.',label:'AST',bonus:function(p){return Math.min((+p.apg||0)*0.78,6);}},
    {name:'NO FLY ZONE',tag:'Rim protection',desc:'Protect the paint. Blocks and defensive presence earn the edge.',label:'BLK',bonus:function(p){return Math.min((+p.bpg||0)*3,6);}},
    {name:'PICKPOCKETS',tag:'Disruption',desc:'Create extra possessions with steals and active hands.',label:'STL',bonus:function(p){return Math.min((+p.spg||0)*3,6);}},
    {name:'CLEAN THE GLASS',tag:'Rebounding',desc:'Finish possessions. Rebounders earn the round bonus.',label:'REB',bonus:function(p){return Math.min((+p.rpg||0)*0.4,6);}},
    {name:'THREE-LEVEL THREAT',tag:'Scoring',desc:'A high-volume scorer who can pressure a defense all over the floor.',label:'PTS',bonus:function(p){return Math.min((+p.ppg||0)*0.2,6);}},
    {name:'THE CONNECTOR',tag:'All-around',desc:'Reward players who contribute in multiple statistical categories.',label:'ALL-AROUND',bonus:function(p){var n=0;if((+p.ppg||0)>=15)n++;if((+p.rpg||0)>=5)n++;if((+p.apg||0)>=4)n++;if((+p.spg||0)>=1)n++;if((+p.bpg||0)>=0.7)n++;return n*1.15;}},
    {name:'TWO-WAY IMPACT',tag:'Two-way play',desc:'Both ends count. Combine scoring with steals and blocks.',label:'PTS + STOCKS',bonus:function(p){return Math.min((+p.ppg||0)*0.12+((+p.spg||0)+(+p.bpg||0))*1.6,6);}},
    {name:'POSSESSION WINS',tag:'Possession game',desc:'Value the players who rebound, create, and disrupt without wasting possessions.',label:'REB + AST + STL',bonus:function(p){return Math.min((+p.rpg||0)*0.2+(+p.apg||0)*0.35+(+p.spg||0)*1.4,6);}},
    {name:'STAR POWER',tag:'Elite production',desc:'The best overall producers get rewarded. Draft the player with the strongest total impact.',label:'SCHRIFT SCORE',bonus:function(p){return Math.min(ss(p)*0.12,6);}}
  ];
  function missionDeck(seed) {
    var deck=challenges.slice(),h=2166136261;
    String(seed||'schriftscore').split('').forEach(function(c){h^=c.charCodeAt(0);h=Math.imul(h,16777619);});
    var state=h>>>0;
    function random(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;}
    for(var i=deck.length-1;i>0;i--){var j=Math.floor(random()*(i+1));var t=deck[i];deck[i]=deck[j];deck[j]=t;}
    return deck.slice(0,5);
  }
  function missionBonus(player, round) {
    var deck=missionDeck(roomId);
    return deck[Math.max(0,Math.min(round,4))].bonus(player);
  }
  function teamScores(picks, pool) {
    return [0,1,2,3].map(function (s) {
      var roster=[],mission=0;
      picks.forEach(function(p,i){
        if(p.seat!==s)return;
        var player=pool.find(function(x){return x.name===p.player_name;})||{name:p.player_name,total:0};
        roster.push(player);mission+=missionBonus(player,Math.floor(i/4));
      });
      var covered={};
      roster.forEach(function(p){roles(p).forEach(function(r){covered[r]=true;});});
      var chemistry=Math.min(10,Object.keys(covered).length*2);
      var base=roster.reduce(function(n,p){return n+ss(p);},0);
      return {seat:s,roster:roster,base:base,chemistry:chemistry,missions:mission,total:base+chemistry+mission,roles:Object.keys(covered)};
    });
  }
  function archetype(p) {
    var a=roles(p);return a[0]||'ROTATION PIECE';
  }
  function fmt(v){return (Number(v)||0).toFixed(1);}
  function aiValue(p, round) {
    return ss(p)+missionBonus(p,round);
  }
  function chooseOnlineAi(available, teamSeat, round, pickCount, roster) {
    var style=['user','film','numbers','bold'][teamSeat]||'numbers';
    var seen={};
    (roster||[]).forEach(function(p){seen[archetype(p)]=true;});
    function noise(seed,max){
      var h=2166136261;
      String(seed).split('').forEach(function(c){h^=c.charCodeAt(0);h=Math.imul(h,16777619);});
      return ((h>>>0)%1000000)/1000000*max;
    }
    return available.slice(0,55).map(function(p){
      var role=archetype(p),value=aiValue(p,round);
      if(style==='film'){if(role==='DEFENSE'||role==='ALL-AROUND')value+=2.2;if(seen[role])value-=1.5;}
      if(style==='numbers'){value+=ss(p)*0.08;if(seen[role])value-=0.5;}
      if(style==='bold'){value+=noise(roomId+'|'+pickCount+'|bold|'+p.name,5);if(ss(p)>25)value+=1.8;}
      value+=noise(roomId+'|'+pickCount+'|'+p.name,1.4);
      return {player:p,value:value};
    }).sort(function(a,b){return b.value-a.value;})[0].player;
  }
  function turnAt(n) {
    var round = Math.floor(n / 4), slot = n % 4;
    return round % 2 === 0 ? slot : 3 - slot;
  }
  function getTurnStartedAt(r,picks) {
    var raw=r.state&&r.state.turn_started_at;
    if(!raw&&picks.length)raw=picks[picks.length-1].picked_at;
    if(!raw)raw=r.state&&r.state.started_at;
    if(!raw)raw=r.created_at;
    var parsed=Date.parse(raw||'');
    return Number.isFinite(parsed)?parsed:Date.now();
  }
  function stopOnlineClock() {
    if(turnClockTimer){clearInterval(turnClockTimer);turnClockTimer=null;}
    turnClockKey='';turnStartedAt=0;autoPickBusy=false;
  }
  function runOnlineClock(r,picks,turn,round,available,teams) {
    if(!r||r.status!=='live'||picks.length>=20){stopOnlineClock();return;}
    var key=roomId+':'+picks.length;
    if(turnClockKey!==key){
      if(turnClockTimer)clearInterval(turnClockTimer);
      turnClockKey=key;turnStartedAt=getTurnStartedAt(r,picks);autoPickBusy=false;
    }
    function tick(){
      var elapsed=Math.max(0,Date.now()-turnStartedAt);
      var remaining=Math.max(0,24-Math.floor(elapsed/1000));
      var clockNode=document.getElementById('sda-online-clock');
      var barNode=document.getElementById('sda-online-clockbar');
      if(clockNode)clockNode.textContent=remaining+'s';
      if(barNode)barNode.style.width=(remaining/24*100)+'%';
      if(remaining===0&&!autoPickBusy&&available.length){
        autoPickBusy=true;
        var chosen=chooseOnlineAi(available,turn,round,picks.length,teams[turn].roster);
        client.rpc('auto_pick_draft_turn',{p_room_id:roomId,p_player_name:chosen.name})
          .then(function(res){if(res.error)throw res.error;refreshRoom();})
          .catch(function(err){var msg=String(err&&err.message||err);if(!msg.toLowerCase().includes('24-second draft clock has not expired'))setMessage(msg);})
          .finally(function(){autoPickBusy=false;});
      }
    }
    tick();if(!turnClockTimer)turnClockTimer=setInterval(tick,250);
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
      if (action === 'rematch') leaveRoom().then(function(){renderHome('Find another match to start your next draft.');});
      if (action === 'pick') submitPick(b.getAttribute('data-player'));
      if (action === 'select') { selectedPlayer=b.getAttribute('data-player'); if(roomId) client.from('draft_rooms').select('*').eq('id',roomId).single().then(function(x){if(!x.error)renderGame(x.data);}); }
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
    var picks=(r.state&&r.state.picks)||[];
    var turn=turnAt(picks.length),myTurn=seat===turn,host=userId===hostId;
    var vacant=!playersInRoom.some(function(p){return p.seat===turn;});
    var pool=getPool().slice().sort(function(a,b){return ss(b)-ss(a);});
    var taken=picks.map(function(p){return p.player_name;});
    var available=pool.filter(function(p){return taken.indexOf(p.name)<0;});
    var teams=teamScores(picks,pool);
    var round=Math.min(4,Math.floor(picks.length/4));
    var deck=missionDeck(roomId),mission=deck[round];
    if(selectedPlayer&&taken.indexOf(selectedPlayer)>=0)selectedPlayer=null;
    if(!selectedPlayer&&available.length)selectedPlayer=available[0].name;
    var selected=available.find(function(p){return p.name===selectedPlayer;})||null;
    var teamNames=['Your Franchise','The Film Room','The Spreadsheet','The Hot Take'];
    var teamIcons=['🫵','🎥','📊','🔥'];
    var html='<div class="flex flex-wrap items-center justify-between gap-3 mb-4"><div><div class="text-[10px] uppercase tracking-[.25em] text-cyan-400 font-black">Live draft · '+picks.length+'/20 picks</div><h2 class="text-2xl sm:text-3xl font-black">ROUND '+Math.min(round+1,5)+' <span class="text-slate-500">/ 5</span></h2></div><div class="flex items-center gap-2"><div class="rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-right"><div class="text-[9px] text-slate-500 uppercase">On the clock</div><div class="font-black text-sm '+(myTurn?'text-lime-300':'text-cyan-300')+'">'+(myTurn?'YOUR PICK':(host&&vacant?'HOST AI PICK':'SEAT '+(turn+1)+' · '+esc((playersInRoom.find(function(p){return p.seat===turn;})||{}).display_name||'AI OPPONENT')))+'</div></div></div></div>';
    html+='<div class="rounded-2xl border border-cyan-400/30 bg-gradient-to-r from-cyan-400/10 to-indigo-400/5 p-4 mb-4"><div class="flex items-center justify-between gap-2"><div><div class="text-[9px] uppercase tracking-[.25em] font-black text-cyan-300">Random mission '+(round+1)+' of 5 · '+mission.tag+'</div><div class="text-xl font-black mt-1">'+mission.name+'</div><div class="text-xs text-slate-300 mt-1">'+mission.desc+'</div></div><div class="text-right shrink-0"><div class="text-[9px] uppercase text-slate-400">Bonus stat</div><div class="text-lg font-black text-cyan-300">'+mission.label+'</div></div></div></div>';
    html+='<div class="grid sm:grid-cols-2 gap-3 mb-4">'+teams.map(function(t){var rp=playersInRoom.find(function(p){return p.seat===t.seat;});var name=rp?rp.display_name:teamNames[t.seat];var icon=rp?'🏀':teamIcons[t.seat];return '<div class="rounded-2xl border '+(t.seat===seat?'border-lime-400/40 bg-lime-400/5':'border-white/10 bg-slate-900')+' p-3"><div class="flex justify-between gap-2"><div class="font-black text-xs truncate">'+icon+' '+esc(name)+(t.seat===seat?' · YOU':'')+'</div><div class="text-sm font-black '+(t.seat===seat?'text-lime-300':'text-cyan-300')+'">'+t.total.toFixed(1)+'</div></div><div class="flex justify-between text-[9px] text-slate-500 mt-1"><span>'+t.roster.length+'/5 drafted</span><span>+'+t.chemistry.toFixed(1)+' chemistry · '+t.roles.length+'/5 types</span></div><div class="text-[9px] text-cyan-300 mt-1">'+(t.roles.length?t.roles.join(' · '):'No archetypes covered yet')+'</div><div class="flex gap-1 mt-2">'+[0,1,2,3,4].map(function(i){return '<div class="flex-1 h-1.5 rounded-full '+(t.roster[i]?(t.seat===seat?'bg-lime-400':'bg-cyan-400'):'bg-white/10')+'"></div>';}).join('')+'</div><div class="mt-2 flex flex-wrap gap-1">'+t.roster.map(function(p){return '<span class="text-[9px] rounded bg-white/5 px-1.5 py-1 text-slate-300">'+esc(p.name)+'</span>';}).join('')+'</div></div>';}).join('')+'</div>';
    var ticker=picks.slice(-8).map(function(p,i){var absolute=picks.length-1-i;var seatNo=p.seat;var playerName=p.player_name;var pl=pool.find(function(x){return x.name===playerName;});return {p:p,seat:seatNo,name:playerName,player:pl};}).reverse();
    html+='<div class="grid xl:grid-cols-[1fr_300px] gap-4"><section class="min-w-0"><div class="rounded-2xl border border-white/10 bg-slate-900 overflow-hidden"><div class="p-3 border-b border-white/10 flex items-center justify-between gap-2"><div><div class="text-xs font-black">PLAYER BOARD</div><div class="text-[9px] text-slate-500">Choose your next pick from the live player pool</div></div><input id="sda-online-search" placeholder="Search player / team" class="w-44 max-w-[48%] rounded-lg bg-slate-950 border border-white/10 px-2 py-2 text-xs outline-none focus:border-cyan-400"></div><div class="grid grid-cols-[1fr_auto] gap-0"><div class="max-h-[48vh] overflow-y-auto divide-y divide-white/5">'+available.slice(0,45).map(function(p){var active=selected&&selected.name===p.name;return '<button type="button" data-online="select" data-player="'+esc(p.name)+'" class="w-full text-left p-3 flex items-center gap-3 hover:bg-white/5 '+(active?'bg-cyan-400/10':'')+'"><div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-[10px] font-black text-slate-400">'+(pool.indexOf(p)+1)+'</div><div class="min-w-0 flex-1"><div class="text-xs font-black truncate">'+esc(p.name)+'</div><div class="text-[9px] text-slate-500">'+esc(p.team||'NBA')+' · '+archetype(p)+'</div></div><div class="text-right"><div class="text-sm font-black text-lime-300">'+ss(p).toFixed(1)+'</div><div class="text-[8px] text-slate-500">SS</div></div></button>';}).join('')+'</div><aside class="border-l border-white/10 p-3 min-w-0">'+(selected?'<div class="text-[9px] uppercase tracking-widest text-cyan-300 font-black">Scouting report</div><div class="text-lg font-black mt-2">'+esc(selected.name)+'</div><div class="text-[10px] text-slate-500">'+esc(selected.team||'NBA')+' · '+archetype(selected)+'</div><div class="text-3xl font-black text-lime-300 mt-4">'+ss(selected).toFixed(2)+'<span class="text-xs text-slate-500 ml-1">SS</span></div><div class="grid grid-cols-2 gap-2 mt-4">'+[['PTS',selected.ppg],['REB',selected.rpg],['AST',selected.apg],['STL',selected.spg],['BLK',selected.bpg]].map(function(x){return '<div class="rounded-lg bg-slate-950 p-2"><div class="text-[8px] text-slate-500">'+x[0]+'</div><div class="font-black text-sm">'+fmt(x[1])+'</div></div>';}).join('')+'</div><div class="mt-3 rounded-lg bg-cyan-400/10 border border-cyan-400/20 p-2"><div class="text-[9px] text-cyan-300 font-bold">ROUND BONUS</div><div class="text-lg font-black">+'+mission.bonus(selected).toFixed(1)+'</div></div><button data-online="pick" data-player="'+esc(selected.name)+'" '+(!myTurn?'disabled':'')+' class="w-full rounded-xl bg-lime-400 hover:bg-lime-300 text-slate-950 font-black text-xs py-3 mt-4 disabled:opacity-30">DRAFT '+esc(selected.name.split(' ').slice(-1)[0].toUpperCase())+' →</button>':'<div class="h-full min-h-48 flex flex-col items-center justify-center text-center"><div class="text-3xl">👀</div><div class="text-xs font-bold mt-2">Select a player</div><div class="text-[9px] text-slate-500 mt-1">View their scouting report before you pick</div></div>')+'</aside></div></div></section>';
    html+='<aside class="space-y-3"><div class="rounded-2xl bg-slate-900 border border-white/10 p-3"><div class="text-[9px] uppercase tracking-widest text-slate-500 font-black mb-2">Draft ticker</div>'+(ticker.length?ticker.map(function(x){var t=playersInRoom.find(function(p){return p.seat===x.seat;});return '<div class="flex items-center justify-between gap-2 py-2 border-b border-white/5"><div class="min-w-0"><div class="text-[10px] text-slate-500">Seat '+(x.seat+1)+'</div><div class="text-xs font-bold truncate">'+esc(t?t.display_name:teamNames[x.seat])+': '+esc(x.name)+'</div></div><div class="text-right shrink-0"><div class="text-xs font-black text-cyan-300">'+(x.player?ss(x.player).toFixed(1):'—')+'</div><div class="text-[9px] text-slate-500">SS</div></div></div>';}).join(''):'<div class="text-xs text-slate-500">The first pick is coming up.</div>')+'</div><div class="rounded-2xl bg-slate-900 border border-white/10 p-3"><div class="text-[9px] uppercase tracking-widest text-slate-500 font-black">Draft clock</div><div class="flex items-end justify-between mt-2"><div class="text-xl font-black '+(myTurn?'text-lime-300':'text-slate-400')+'">'+(myTurn?'YOUR PICK':'WAITING FOR SEAT '+(turn+1))+'</div><div id="sda-online-clock" class="text-3xl tabular-nums font-black text-cyan-300">24s</div></div><div class="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2"><div id="sda-online-clockbar" class="h-full rounded-full bg-cyan-300" style="width:100%"></div></div><div class="text-[10px] text-slate-500 mt-2">'+(myTurn?'Make your pick before the 24-second clock expires.':'Every pick has a 24-second limit. An automatic pick follows when time expires.')+'</div><div class="mt-3 text-xs font-bold text-cyan-300">'+(picks.length?'Latest pick: '+esc(picks[picks.length-1].player_name):'The first pick is coming up.')+'</div></div></aside></div>';
    html+='<p id="sda-online-message" class="text-sm text-rose-300 mt-3"></p><div class="text-[10px] text-slate-500 mt-2">Snake draft · Schrift Score totals + mission bonuses + up to 10 chemistry points · Duplicate picks and out-of-turn picks are rejected by the database.</div>';
    var node=document.getElementById('sda-online-game');
    if(node)node.innerHTML=html;
    var search=document.getElementById('sda-online-search');
    if(search)search.addEventListener('input',function(){var q=this.value.toLowerCase();Array.from(node.querySelectorAll('[data-online="select"]')).forEach(function(row){var name=row.getAttribute('data-player')||'';row.style.display=name.toLowerCase().includes(q)?'flex':'none';});});
    if(host&&vacant&&r.status==='live'&&picks.length<20&&!botBusy&&available.length){
      botBusy=true;
      setTimeout(function(){var chosen=chooseOnlineAi(available,turn,round,picks.length,teams[turn].roster);var result=client.rpc('submit_draft_pick',{p_room_id:roomId,p_player_name:chosen.name});result.then(function(res){botBusy=false;if(res.error){refreshRoom();if(!String(res.error.message||'').toLowerCase().includes('not your turn'))setMessage(res.error.message);}else refreshRoom();}).catch(function(e){botBusy=false;setMessage(e.message);});},600);
    }
    if(r.status==='live'&&picks.length<20)runOnlineClock(r,picks,turn,round,available,teams);
    if(r.status==='finished')renderOnlineResults(r,picks,pool,teams);
  }
  function renderOnlineResults(r,picks,pool,teams) {
    var ranked=teams.slice().sort(function(a,b){return b.total-a.total;});
    var mine=ranked.find(function(t){return t.seat===seat;})||ranked[0];
    var rank=ranked.findIndex(function(t){return t.seat===seat;})+1;
    var winner=ranked[0],winnerPick=winner.roster.slice().sort(function(a,b){return ss(b)-ss(a);})[0];
    var mvp=picks.map(function(p){return pool.find(function(x){return x.name===p.player_name;})||{name:p.player_name,total:0};}).sort(function(a,b){return ss(b)-ss(a);})[0];
    var minePicks=picks.filter(function(p){return p.seat===seat;});
    var names=['Your Franchise','The Film Room','The Spreadsheet','The Hot Take'];
    function teamName(t){var p=playersInRoom.find(function(x){return x.seat===t.seat;});return p?p.display_name:names[t.seat];}
    var html='<div class="max-w-5xl mx-auto rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-cyan-400/10 to-slate-900 p-5 mt-5"><div class="text-center py-5"><div class="text-5xl">'+(rank===1?'🏆':'🏀')+'</div><div class="text-[10px] uppercase tracking-[.3em] text-cyan-300 font-black mt-3">Final results</div><h2 class="text-3xl sm:text-5xl font-black mt-2">'+(rank===1?'YOU RUN THE LEAGUE.':'THE ROOM GOT YOU.')+'</h2><p class="text-sm text-slate-400 mt-2">'+(rank===1?'You out-drafted every front office in the room.':'You finished #'+rank+'. Run it back and build a better roster.')+'</p></div><div class="text-xs uppercase tracking-widest text-cyan-300 font-black">Final standings</div><div class="mt-4 space-y-2">'+ranked.map(function(t,i){return '<div class="rounded-xl '+(i===0?'bg-cyan-400/15 border border-cyan-400/40':'bg-black/20 border border-white/5')+' p-3 flex items-center gap-3"><div class="text-xl font-black w-8">'+['🥇','🥈','🥉','4th'][i]+'</div><div class="min-w-0 flex-1"><div class="font-black text-sm">'+esc(teamName(t))+(t.seat===seat?' · YOU':'')+'</div><div class="text-[9px] text-slate-500">'+t.roster.map(function(x){return esc(x.name);}).join(' · ')+'</div></div><div class="text-right"><div class="text-xl font-black '+(i===0?'text-cyan-300':'text-white')+'">'+t.total.toFixed(1)+'</div><div class="text-[9px] text-slate-500">'+t.base.toFixed(1)+' SS + '+t.chemistry.toFixed(1)+' chemistry + '+t.missions.toFixed(1)+' mission</div></div></div>';}).join('')+'</div><div class="grid sm:grid-cols-3 gap-3 mt-4"><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Draft MVP</div><div class="font-black text-lg mt-2">'+esc(mvp?mvp.name:'—')+'</div><div class="text-xs text-lime-300">'+(mvp?ss(mvp).toFixed(2):'0.00')+' Schrift Score</div></div><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Winning GM</div><div class="font-black text-lg mt-2">'+esc(teamName(winner))+'</div><div class="text-xs text-cyan-300">'+esc(winnerPick?winnerPick.name:'—')+' · top pick</div></div><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Your finish</div><div class="font-black text-3xl mt-2">'+rank+'<span class="text-sm text-slate-500"> / 4</span></div><div class="text-xs text-lime-300">'+mine.total.toFixed(1)+' total points</div></div></div><div class="rounded-2xl bg-slate-900 border border-white/10 p-4 mt-4"><div class="font-black text-sm">YOUR DRAFT CLASS</div><div class="grid sm:grid-cols-5 gap-2 mt-3">'+minePicks.map(function(x){var p=pool.find(function(y){return y.name===x.player_name;});return '<div class="rounded-xl bg-slate-950 p-3"><div class="text-[9px] text-slate-500">ROUND '+x.round+'</div><div class="text-xs font-black mt-1">'+esc(x.player_name)+'</div><div class="text-lg font-black text-lime-300 mt-2">'+(p?ss(p).toFixed(1):'0.0')+'</div><div class="text-[9px] text-cyan-300">+'+(p?missionBonus(p,x.round-1):0).toFixed(1)+' mission</div></div>';}).join('')+'</div></div><div class="flex flex-wrap justify-center gap-3 mt-6"><button data-online="rematch" class="rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-black px-7 py-3">FIND ANOTHER MATCH ↻</button><button data-online="leave" class="rounded-xl border border-white/15 px-7 py-3 text-sm font-bold">BACK TO MENU</button></div></div>';
    var node=document.getElementById('sda-online-game');if(node)node.insertAdjacentHTML('beforeend',html);
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(roomCode); setMessage('Room code copied.'); }
    catch(e) { setMessage('Your room code is '+roomCode+'.'); }
  }
  async function leaveRoom(showHome) {
    var leavingId = roomId;
    if (channel && client) { client.removeChannel(channel); channel = null; }
    if (publicStartTimer) clearTimeout(publicStartTimer);
    publicStartTimer=null;publicStartRoomId=null;isPublicRoom=false;stopOnlineClock();
    if (leavingId && client && userId) {
      try {
        var result = await client.rpc('leave_draft_room', {p_room_id:leavingId});
        if (result.error && showHome !== false) setMessage(result.error.message || String(result.error));
      } catch (e) {
        if (showHome !== false) setMessage(e.message || String(e));
      }
    }
    roomId=null;roomCode='';seat=null;hostId=null;playersInRoom=[];botBusy=false;selectedPlayer=null;turnClockKey='';turnStartedAt=0;
    if (showHome !== false) renderHome();
  }
  window.openOnlineDraftRoom = open;
})();