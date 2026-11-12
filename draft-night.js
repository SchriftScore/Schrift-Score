/* Schrift Score Draft Arena — fast, head-to-head fantasy front-office draft */
(function () {
  'use strict';
  var rootId = 'schrift-draft-arena';
  var game = null;
  var clock = null;
  var aiTimer = null;
  var challenges = [
    {name:'GET BUCKETS',tag:'Scoring specialist',desc:'This round rewards pure scoring. Find a player who can carry an offense.',key:'points',bonus:function(p){return Math.min((+p.ppg||0)*0.22,6);},label:'PTS'},
    {name:'RUN THE OFFENSE',tag:'Floor general',desc:'Playmaking is the assignment. Find the player who makes everyone better.',key:'assists',bonus:function(p){return Math.min((+p.apg||0)*0.72,6);},label:'AST'},
    {name:'LOCKDOWN',tag:'Defensive menace',desc:'Stocks matter. Steals and blocks can swing this round.',key:'defense',bonus:function(p){return Math.min(((+p.spg||0)+(+p.bpg||0))*2.1,6);},label:'STL + BLK'},
    {name:'OWN THE GLASS',tag:'Rebounding machine',desc:'Control the boards. Rebounds earn the round bonus.',key:'rebounds',bonus:function(p){return Math.min((+p.rpg||0)*0.42,6);},label:'REB'},
    {name:'THE COMPLETE PLAYER',tag:'No weaknesses',desc:'The final round rewards players who contribute across the board.',key:'complete',bonus:function(p){var n=0;if((+p.ppg||0)>=18)n++;if((+p.rpg||0)>=6)n++;if((+p.apg||0)>=4)n++;if((+p.spg||0)>=1)n++;if((+p.bpg||0)>=0.8)n++;return n*1.25;},label:'ALL-AROUND'}
  ];
  var gmTemplates = [
    {name:'The Film Room',style:'film',line:'Trusts two-way players and complete games.',emoji:'🎥'},
    {name:'The Spreadsheet',style:'numbers',line:'Chases value and the best score on the board.',emoji:'📊'},
    {name:'The Hot Take',style:'bold',line:'Will reach for a star if the upside is there.',emoji:'🔥'}
  ];
  function el(id){return document.getElementById(id);}
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function fmt(v){return (Number(v)||0).toFixed(1);}
  function score(p){return Number(p.total)||0;}
  function poolData(){
    try { if(typeof getDraftPool==='function') return getDraftPool().filter(function(p){return p&&p.name&&Number.isFinite(Number(p.total));}); } catch(e){}
    try { if(typeof masterData!=='undefined') return masterData.filter(function(p){return p&&p.name&&Number.isFinite(Number(p.total));}); } catch(e){}
    return [];
  }
  function role(p){
    var pts=+p.ppg||0,reb=+p.rpg||0,ast=+p.apg||0,stl=+p.spg||0,blk=+p.bpg||0;
    if(pts>=22)return 'BUCKET GETTER';
    if(ast>=6)return 'FLOOR GENERAL';
    if(stl>=1.5||blk>=1.5)return 'LOCKDOWN';
    if(reb>=9)return 'GLASS CLEANER';
    if(pts>=15&&reb>=5&&ast>=4)return 'ALL-AROUND';
    return 'ROTATION PIECE';
  }
  function bonus(p,round){return challenges[round].bonus(p);}
  function playerValue(p,round){return score(p)+bonus(p,round);}
  function teamScore(t){
    var base=t.roster.reduce(function(n,p){return n+score(p);},0);
    var roles={};t.roster.forEach(function(p){var r=role(p);if(r!=='ROTATION PIECE')roles[r]=true;});
    var coverage=Object.keys(roles).length;
    var chemistry=Math.max(0,coverage-1)*2.5;
    return {base:base,chemistry:chemistry,total:base+chemistry,coverage:coverage};
  }
  function makeTeams(name){
    return [{id:0,name:name||'Your Franchise',user:true,style:'user',emoji:'🫵',roster:[],score:0},
      {id:1,name:gmTemplates[0].name,style:'film',emoji:'🎥',roster:[],score:0},
      {id:2,name:gmTemplates[1].name,style:'numbers',emoji:'📊',roster:[],score:0},
      {id:3,name:gmTemplates[2].name,style:'bold',emoji:'🔥',roster:[],score:0}];
  }
  function orderForPick(n){
    var round=Math.floor(n/4),slot=n%4;
    return round%2===0?slot:3-slot;
  }
  function currentRound(){return Math.floor(game.picks.length/4);}
  function userTurn(){return !game.finished&&orderForPick(game.picks.length)===0;}
  function initModal(){
    if(el(rootId))return;
    var modal=document.createElement('div');modal.id=rootId;
    modal.className='hidden fixed inset-0 z-[90] bg-slate-950/95 backdrop-blur-md text-white';
    modal.innerHTML='<div class="w-full h-full overflow-y-auto"><div class="max-w-[1500px] mx-auto min-h-full flex flex-col">'+
      '<header class="sticky top-0 z-20 bg-slate-950/95 border-b border-white/10 px-4 sm:px-6 py-3 flex items-center justify-between gap-3"><div><div class="text-[10px] uppercase tracking-[.3em] text-amber-400 font-black">Schrift Score presents</div><div class="text-xl sm:text-2xl font-black tracking-tight">DRAFT <span class="text-amber-400">ARENA</span></div></div><button data-action="close" class="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 hover:bg-white/10">✕ <span class="hidden sm:inline">Exit</span></button></header>'+
      '<main id="sda-main" class="flex-1 p-3 sm:p-6"></main>'+
      '<footer class="px-4 py-3 border-t border-white/10 text-center text-[10px] text-slate-500">Real NBA player stats · Schrift Score scoring · Built for competition</footer></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click',handleClick);
    modal.addEventListener('input',handleInput);
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!modal.classList.contains('hidden'))close();});
  }
  function open(){initModal();el(rootId).classList.remove('hidden');document.body.classList.add('overflow-hidden');showSetup();}
  function close(){if(el(rootId))el(rootId).classList.add('hidden');document.body.classList.remove('overflow-hidden');stopClock();}
  function stopClock(){if(clock){clearInterval(clock);clock=null;}if(aiTimer){clearTimeout(aiTimer);aiTimer=null;}}
  function showSetup(){
    stopClock();game=null;
    var pool=poolData();
    el('sda-main').innerHTML=
      '<div class="grid lg:grid-cols-[1.15fr_.85fr] gap-5 items-stretch">'+
      '<section class="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 p-5 sm:p-8 relative overflow-hidden"><div class="absolute -right-10 -top-10 w-64 h-64 rounded-full bg-amber-400/10 blur-3xl"></div><div class="relative"><div class="inline-flex items-center gap-2 rounded-full bg-amber-400/10 border border-amber-400/30 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-amber-300">New game mode</div><h1 class="text-4xl sm:text-6xl font-black leading-[.95] mt-5">BUILD A<br><span class="text-amber-400">WINNER.</span></h1><p class="text-slate-300 text-sm sm:text-base mt-4 max-w-xl">Four front offices. Five rounds. One champion. Draft real NBA players, outsmart rival GMs, and prove you know basketball better than the room.</p><div class="grid grid-cols-3 gap-2 mt-7"><div class="rounded-2xl bg-black/30 p-3"><div class="text-2xl font-black">4</div><div class="text-[9px] text-slate-400 uppercase tracking-wider">GMs</div></div><div class="rounded-2xl bg-black/30 p-3"><div class="text-2xl font-black">5</div><div class="text-[9px] text-slate-400 uppercase tracking-wider">Rounds</div></div><div class="rounded-2xl bg-black/30 p-3"><div class="text-2xl font-black">20</div><div class="text-[9px] text-slate-400 uppercase tracking-wider">Total picks</div></div></div>'+
      '<label class="block text-[10px] uppercase tracking-widest text-slate-400 font-bold mt-7 mb-2">Name your franchise</label><input id="sda-team-name" maxlength="24" value="Your Franchise" class="w-full max-w-sm rounded-xl bg-slate-950 border border-white/15 px-4 py-3 text-sm outline-none focus:border-amber-400">'+
      '<button data-action="start" class="mt-4 w-full sm:w-auto rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-8 py-4 text-sm shadow-lg shadow-amber-400/20 transition">ENTER THE DRAFT ARENA →</button>'+
      '<div class="text-[10px] text-slate-500 mt-3">'+pool.length+' players loaded from the live Schrift Score player pool</div></div></section>'+
      '<section class="rounded-3xl border border-white/10 bg-slate-900 p-5 sm:p-7"><div class="text-xs uppercase tracking-[.2em] font-black text-slate-400">The rules</div><div class="space-y-5 mt-5">'+
      rule('01','Snake draft','You and three AI GMs take turns. Draft order reverses every round. You get five picks.','↔️')+
      rule('02','Round challenges','Every round has a different mission: scoring, playmaking, defense, rebounding, and all-around impact.','🎯')+
      rule('03','Build chemistry','Draft different player types to unlock roster chemistry points. A team of five one-dimensional scorers will not automatically win.','🧩')+
      rule('04','Beat the room','Your final roster score combines real Schrift Score totals, round challenge bonuses, and lineup chemistry.','🏆')+
      '</div><div class="mt-7 border-t border-white/10 pt-5"><div class="font-black text-sm">ONLINE MULTIPLAYER</div><p class="text-xs text-slate-400 mt-1">I’m designing this as a real invite-a-friend mode, not a fake room code. It needs a shared realtime game server before players on different devices can draft together.</p><div class="mt-3 inline-flex rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-[10px] font-bold text-sky-300">ONLINE ROOMS · NEXT BUILD</div></div></section></div>'+
      '<div class="text-center text-[10px] text-slate-500 mt-5">Designed to be a quick 3–5 minute showdown. No 144-player auction marathons.</div>';
  }
  function rule(n,title,desc,icon){return '<div class="flex gap-3"><div class="w-10 h-10 shrink-0 rounded-xl bg-white/5 flex items-center justify-center text-lg">'+icon+'</div><div><div class="text-sm font-black">'+n+' · '+title+'</div><p class="text-xs leading-relaxed text-slate-400 mt-1">'+desc+'</p></div></div>';}
  function start(){
    var pool=poolData();if(pool.length<20){alert('The live player pool has not loaded yet. Wait for the Schrift Score leaderboard to finish loading, then try again.');return;}
    var name=(el('sda-team-name').value||'Your Franchise').trim().slice(0,24)||'Your Franchise';
    var teams=makeTeams(name);
    game={teams:teams,pool:pool.slice().sort(function(a,b){return score(b)-score(a);}),picks:[],feed:[],selected:null,seconds:22,finished:false,started:Date.now(),bestSteal:null};
    pushFeed('The commissioner has opened the draft. Five rounds. No excuses.','system');
    renderLive();
    nextTurn();
  }
  function pushFeed(message,type){game.feed.unshift({message:message,type:type||'normal'});game.feed=game.feed.slice(0,16);}
  function gmPick(team,round){
    var available=game.pool.slice(0,Math.min(55,game.pool.length));
    if(!available.length)return null;
    var candidates=available.map(function(p){
      var r=role(p),has=team.roster.some(function(x){return role(x)===r;});
      var v=playerValue(p,round);
      if(team.style==='film'){if(r==='LOCKDOWN'||r==='ALL-AROUND')v+=2.2;if(has)v-=1.5;}
      if(team.style==='numbers'){v+=score(p)*.08;if(has)v-=.5;}
      if(team.style==='bold'){v+=Math.random()*5;if(score(p)>25)v+=1.8;}
      v+=Math.random()*1.4;
      return {p:p,v:v};
    }).sort(function(a,b){return b.v-a.v;});
    return candidates[0].p;
  }
  function nextTurn(){
    if(!game||game.finished)return;
    if(game.picks.length>=20){finish();return;}
    var teamId=orderForPick(game.picks.length),team=game.teams[teamId],round=currentRound();
    if(teamId===0){game.seconds=22;renderLive();startClock();}
    else{
      renderLive();
      aiTimer=setTimeout(function(){if(!game||game.finished)return;var p=gmPick(team,round);makePick(teamId,p);},750+Math.random()*650);
    }
  }
  function startClock(){
    stopClock();
    clock=setInterval(function(){
      if(!game||game.finished||!userTurn()){stopClock();return;}
      game.seconds--;
      var n=el('sda-clock');if(n)n.textContent=game.seconds+'s';
      var bar=el('sda-clockbar');if(bar)bar.style.width=(game.seconds/22*100)+'%';
      if(game.seconds<=0){var p=gmPick(game.teams[0],currentRound());pushFeed('Clock expired. Auto-pick: '+p.name+'.','warning');makePick(0,p);}
    },1000);
  }
  function makePick(teamId,p){
    if(!game||game.finished||!p)return;
    var team=game.teams[teamId],round=currentRound();
    if(!team||team.roster.length>=5)return;
    var ix=game.pool.findIndex(function(x){return x.name===p.name;});if(ix<0)return;
    var expected=game.pool.slice().sort(function(a,b){return score(b)-score(a);}).findIndex(function(x){return x.name===p.name;})+1;
    var pickNo=game.picks.length+1,extra=bonus(p,round);
    team.roster.push(p);team.score=teamScore(team).total;
    game.picks.push({pick:pickNo,round:round+1,team:teamId,player:p,bonus:extra,expected:expected});
    game.pool.splice(ix,1);game.selected=null;
    if(teamId===0){
      var steal=score(p)+extra;
      if(!game.bestSteal||expected>game.bestSteal.expected)game.bestSteal={player:p,expected:expected,team:team.name};
      pushFeed('YOU SELECT '+p.name+'. '+role(p)+' added to your roster.','user');
    }else{
      var line=team.name+' selects '+p.name+'.';
      if(team.style==='bold'&&score(p)>25)line+=' The room is stunned.';
      pushFeed(line,'ai');
    }
    stopClock();renderLive();
    if(game.picks.length>=20){setTimeout(finish,550);return;}
    aiTimer=setTimeout(nextTurn,450);
  }
  function choose(name){
    if(!game||!userTurn())return;
    var p=game.pool.find(function(x){return x.name===name;});if(!p)return;
    game.selected=name;renderLive();
  }
  function renderLive(){
    if(!game)return;
    var round=currentRound(),teamId=orderForPick(game.picks.length),onClock=teamId===0,mission=challenges[Math.min(round,4)];
    var teams=game.teams.slice().sort(function(a,b){return teamScore(b).total-teamScore(a).total;});
    var selected=game.pool.find(function(p){return p.name===game.selected;});
    var q=game.search||'';
    var players=game.pool.filter(function(p){return !q||p.name.toLowerCase().includes(q.toLowerCase())||String(p.team||'').toLowerCase().includes(q.toLowerCase());}).slice(0,45);
    var picksHtml=game.picks.slice(-8).reverse().map(function(x){return '<div class="flex items-center justify-between gap-2 py-2 border-b border-white/5"><div class="min-w-0"><div class="text-[10px] text-slate-500">R'+x.round+' · '+x.team+'</div><div class="text-xs font-bold truncate">'+esc(game.teams[x.team].name)+': '+esc(x.player.name)+'</div></div><div class="text-right shrink-0"><div class="text-xs font-black text-amber-300">'+score(x.player).toFixed(1)+'</div><div class="text-[9px] text-slate-500">SS</div></div></div>';}).join('');
    el('sda-main').innerHTML=
      '<div class="flex flex-wrap items-center justify-between gap-3 mb-4"><div><div class="text-[10px] uppercase tracking-[.25em] text-amber-400 font-black">Live draft · '+game.picks.length+'/20 picks</div><h2 class="text-2xl sm:text-3xl font-black">ROUND '+Math.min(round+1,5)+' <span class="text-slate-500">/ 5</span></h2></div><div class="flex items-center gap-2"><div class="rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-right"><div class="text-[9px] text-slate-500 uppercase">On the clock</div><div class="font-black text-sm '+(onClock?'text-emerald-300':'text-amber-300')+'">'+(onClock?'YOUR PICK':esc(game.teams[teamId].name))+'</div></div><button data-action="exit" class="text-xs text-slate-400 hover:text-white px-2">Exit</button></div></div>'+
      '<div class="rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-400/15 to-orange-400/5 p-4 mb-4"><div class="flex items-center justify-between gap-2"><div><div class="text-[9px] uppercase tracking-[.25em] font-black text-amber-300">Round '+(round+1)+' mission · '+mission.tag+'</div><div class="text-xl font-black mt-1">'+mission.name+'</div><div class="text-xs text-slate-300 mt-1">'+mission.desc+'</div></div><div class="text-right shrink-0"><div class="text-[9px] uppercase text-slate-400">Bonus stat</div><div class="text-lg font-black text-amber-300">'+mission.label+'</div></div></div></div>'+
      '<div class="grid xl:grid-cols-[1fr_300px] gap-4"><section class="min-w-0"><div class="grid sm:grid-cols-2 gap-3 mb-3">'+teams.map(function(t){var s=teamScore(t);return '<div class="rounded-2xl border '+(t.user?'border-emerald-400/40 bg-emerald-400/5':'border-white/10 bg-slate-900')+' p-3"><div class="flex justify-between gap-2"><div class="font-black text-xs truncate">'+t.emoji+' '+esc(t.name)+(t.user?' · YOU':'')+'</div><div class="text-sm font-black '+(t.user?'text-emerald-300':'text-amber-300')+'">'+s.total.toFixed(1)+'</div></div><div class="flex justify-between text-[9px] text-slate-500 mt-1"><span>'+t.roster.length+'/5 drafted</span><span>+ '+s.chemistry.toFixed(1)+' chemistry</span></div><div class="flex gap-1 mt-2">'+[0,1,2,3,4].map(function(i){return '<div class="flex-1 h-1.5 rounded-full '+(t.roster[i]?(t.user?'bg-emerald-400':'bg-amber-400'):'bg-white/10')+'"></div>';}).join('')+'</div><div class="mt-2 flex flex-wrap gap-1">'+t.roster.map(function(p){return '<span class="text-[9px] rounded bg-white/5 px-1.5 py-1 text-slate-300">'+esc(p.name)+'</span>';}).join('')+'</div></div>';}).join('')+'</div>'+
      '<div class="rounded-2xl border border-white/10 bg-slate-900 overflow-hidden"><div class="p-3 border-b border-white/10 flex items-center justify-between gap-2"><div><div class="text-xs font-black">PLAYER BOARD</div><div class="text-[9px] text-slate-500">Choose your next pick from the live player pool</div></div><input id="sda-search" value="'+esc(q)+'" placeholder="Search player / team" class="w-44 max-w-[48%] rounded-lg bg-slate-950 border border-white/10 px-2 py-2 text-xs outline-none focus:border-amber-400" '+(onClock?'':'disabled')+'></div>'+
      '<div class="grid grid-cols-[1fr_auto] gap-0"><div class="max-h-[48vh] overflow-y-auto divide-y divide-white/5">'+(players.map(function(p){var active=selected&&selected.name===p.name;return '<button data-player="'+esc(p.name)+'" '+(onClock?'':'disabled')+' class="w-full text-left p-3 flex items-center gap-3 hover:bg-white/5 disabled:opacity-50 '+(active?'bg-amber-400/10':'')+'"><div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-[10px] font-black text-slate-400">'+(game.pool.indexOf(p)+1)+'</div><div class="min-w-0 flex-1"><div class="text-xs font-black truncate">'+esc(p.name)+'</div><div class="text-[9px] text-slate-500">'+esc(p.team||'NBA')+' · '+role(p)+'</div></div><div class="text-right"><div class="text-sm font-black text-emerald-300">'+score(p).toFixed(1)+'</div><div class="text-[8px] text-slate-500">SS</div></div></button>';}).join('')||'<div class="p-6 text-center text-xs text-slate-500">No players found.</div>')+'</div>'+
      '<aside class="border-l border-white/10 p-3 min-w-0">'+(selected?'<div class="text-[9px] uppercase tracking-widest text-amber-300 font-black">Scouting report</div><div class="text-lg font-black mt-2">'+esc(selected.name)+'</div><div class="text-[10px] text-slate-500">'+esc(selected.team||'NBA')+' · '+role(selected)+'</div><div class="text-3xl font-black text-emerald-300 mt-4">'+score(selected).toFixed(2)+'<span class="text-xs text-slate-500 ml-1">SS</span></div><div class="grid grid-cols-2 gap-2 mt-4">'+[['PTS',selected.ppg],['REB',selected.rpg],['AST',selected.apg],['STL',selected.spg],['BLK',selected.bpg]].map(function(x){return '<div class="rounded-lg bg-slate-950 p-2"><div class="text-[8px] text-slate-500">'+x[0]+'</div><div class="font-black text-sm">'+fmt(x[1])+'</div></div>';}).join('')+'</div><div class="mt-3 rounded-lg bg-amber-400/10 border border-amber-400/20 p-2"><div class="text-[9px] text-amber-300 font-bold">ROUND BONUS</div><div class="text-lg font-black">+'+bonus(selected,round).toFixed(1)+'</div></div><button data-action="pick" class="w-full rounded-xl bg-emerald-400 hover:bg-emerald-300 text-slate-950 font-black text-xs py-3 mt-4">DRAFT '+esc(selected.name.split(' ').slice(-1)[0].toUpperCase())+' →</button>':'<div class="h-full min-h-48 flex flex-col items-center justify-center text-center"><div class="text-3xl">👀</div><div class="text-xs font-bold mt-2">Select a player</div><div class="text-[9px] text-slate-500 mt-1">View their scouting report before you pick</div></div>')+'</aside></div></div>'+
      '<div class="grid md:grid-cols-2 gap-3 mt-3"><div class="rounded-2xl bg-slate-900 border border-white/10 p-3"><div class="text-[9px] uppercase tracking-widest text-slate-500 font-black mb-2">Draft ticker</div>'+(picksHtml||'<div class="text-xs text-slate-500">The first pick is coming up.</div>')+'</div><div class="rounded-2xl bg-slate-900 border border-white/10 p-3"><div class="flex items-center justify-between"><div class="text-[9px] uppercase tracking-widest text-slate-500 font-black">Draft clock</div><div id="sda-clock" class="text-xl font-black '+(onClock?'text-emerald-300':'text-slate-500')+'">'+(onClock?game.seconds+'s':'AI PICKING')+'</div></div><div class="h-2 bg-slate-800 rounded-full mt-2 overflow-hidden"><div id="sda-clockbar" class="h-full bg-emerald-400 transition-all" style="width:'+(onClock?game.seconds/22*100:0)+'%"></div></div><div class="text-[10px] text-slate-500 mt-3">'+(onClock?'Make your pick before the clock hits zero.':'The rival front office is making its move...')+'</div><div class="mt-3 text-xs font-bold text-amber-300">'+esc(game.feed[0]?game.feed[0].message.replace(/<[^>]*>/g,''):'Draft started.')+'</div></div></div></section></div>';
  }
  function finish(){
    if(!game||game.finished)return;stopClock();game.finished=true;
    var standings=game.teams.map(function(t){var s=teamScore(t);return {team:t,score:s.total,base:s.base,chemistry:s.chemistry,coverage:s.coverage};}).sort(function(a,b){return b.score-a.score;});
    game.standings=standings;renderResults();
  }
  function renderResults(){
    var s=game.standings,w=s[0],me=s.find(function(x){return x.team.user;}),rank=s.findIndex(function(x){return x.team.user;})+1;
    var winnerPick=w.team.roster.slice().sort(function(a,b){return score(b)-score(a);})[0];
    var mvp=game.picks.slice().sort(function(a,b){return score(b.player)-score(a.player);})[0];
    var picks=game.picks.filter(function(x){return x.team===0;});
    el('sda-main').innerHTML='<div class="max-w-5xl mx-auto"><div class="text-center py-7"><div class="text-5xl">'+(rank===1?'🏆':'🏀')+'</div><div class="text-[10px] uppercase tracking-[.3em] text-amber-300 font-black mt-4">Final results</div><h2 class="text-4xl sm:text-6xl font-black mt-2">'+(rank===1?'YOU RUN THE LEAGUE.':'THE ROOM GOT YOU.')+'</h2><p class="text-sm text-slate-400 mt-2">'+(rank===1?'You out-drafted every front office in the room.':'You finished #'+rank+'. Run it back and build a better roster.')+'</p></div>'+
      '<div class="rounded-3xl border border-amber-400/30 bg-gradient-to-br from-amber-400/10 to-slate-900 p-5"><div class="text-xs uppercase tracking-widest text-amber-300 font-black">Final standings</div><div class="mt-4 space-y-2">'+s.map(function(x,i){return '<div class="rounded-xl '+(i===0?'bg-amber-400/15 border border-amber-400/40':'bg-black/20 border border-white/5')+' p-3 flex items-center gap-3"><div class="text-xl font-black w-8">'+['🥇','🥈','🥉','4th'][i]+'</div><div class="min-w-0 flex-1"><div class="font-black text-sm">'+esc(x.team.name)+(x.team.user?' · YOU':'')+'</div><div class="text-[9px] text-slate-500">'+x.team.roster.map(function(p){return esc(p.name);}).join(' · ')+'</div></div><div class="text-right"><div class="text-xl font-black '+(i===0?'text-amber-300':'text-white')+'">'+x.score.toFixed(1)+'</div><div class="text-[9px] text-slate-500">'+x.base.toFixed(1)+' SS + '+x.chemistry.toFixed(1)+' chemistry</div></div></div>';}).join('')+'</div></div>'+
      '<div class="grid sm:grid-cols-3 gap-3 mt-4"><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Draft MVP</div><div class="font-black text-lg mt-2">'+esc(mvp.player.name)+'</div><div class="text-xs text-emerald-300">'+score(mvp.player).toFixed(2)+' Schrift Score</div></div><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Winning GM</div><div class="font-black text-lg mt-2">'+esc(w.team.name)+'</div><div class="text-xs text-amber-300">'+esc(winnerPick?winnerPick.name:'—')+' · top pick</div></div><div class="rounded-2xl bg-slate-900 border border-white/10 p-4"><div class="text-[9px] uppercase tracking-widest text-slate-500">Your finish</div><div class="font-black text-3xl mt-2">'+rank+'<span class="text-sm text-slate-500"> / 4</span></div><div class="text-xs text-emerald-300">'+me.score.toFixed(1)+' total points</div></div></div>'+
      '<div class="rounded-2xl bg-slate-900 border border-white/10 p-4 mt-4"><div class="font-black text-sm">YOUR DRAFT CLASS</div><div class="grid sm:grid-cols-5 gap-2 mt-3">'+picks.map(function(x){return '<div class="rounded-xl bg-slate-950 p-3"><div class="text-[9px] text-slate-500">ROUND '+x.round+'</div><div class="text-xs font-black mt-1">'+esc(x.player.name)+'</div><div class="text-lg font-black text-emerald-300 mt-2">'+score(x.player).toFixed(1)+'</div><div class="text-[9px] text-amber-300">+'+x.bonus.toFixed(1)+' mission</div></div>';}).join('')+'</div></div>'+
      '<div class="flex flex-wrap justify-center gap-3 mt-6"><button data-action="rematch" class="rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-7 py-3">RUN IT BACK ↻</button><button data-action="home" class="rounded-xl border border-white/15 px-7 py-3 text-sm font-bold">BACK TO MENU</button></div></div>';
  }
  function handleClick(e){
    var player=e.target.closest('[data-player]');
    if(player){choose(player.getAttribute('data-player'));return;}
    var btn=e.target.closest('[data-action]');if(!btn)return;
    var action=btn.getAttribute('data-action');
    if(action==='close'||action==='exit'){close();return;}
    if(action==='start'){start();return;}
    if(action==='pick'&&game&&game.selected){var p=game.pool.find(function(x){return x.name===game.selected;});if(p)makePick(0,p);return;}
    if(action==='rematch'){var name=game&&game.teams[0].name;showSetup();if(el('sda-team-name'))el('sda-team-name').value=name||'Your Franchise';return;}
    if(action==='home'){showSetup();return;}
  }
  function handleInput(e){if(e.target&&e.target.id==='sda-search'&&game){game.search=e.target.value;var pos=e.target.selectionStart;renderLive();var n=el('sda-search');if(n){n.focus();n.setSelectionRange(pos,pos);}}}
  window.openDraftNight=open;
  window.closeDraftNight=close;
  window.startDraftNight=start;
  window.startAuctionDraft=function(){open();};
})();
