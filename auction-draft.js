(function () {
  'use strict';
  var BUDGET = 200, ROSTER = 12, TEAM_NAMES = [
    ['The Contenders','Superstar Chaser',1.28],['Cap Space FC','Bargain Hunter',0.82],
    ['Buckets Only','Offensive GM',1.12],['Lockdown Lab','Defensive GM',1.04],
    ['The Blueprint','Balanced Builder',1],['No Fear Front Office','Aggressive GM',1.22],
    ['Patient Capital','Patient GM',0.90],['Dime Droppers','Playmaking Specialist',1.02],
    ['Above the Rim','Rim Protector',1.05],['The Spreadsheet','Value Analyst',0.94],
    ['Win Now Group','Win-Now GM',1.16]
  ];
  window.auctionDraftState = window.auctionDraftState || {active:false,finished:false,teams:[],pool:[],selectedName:'',current:null,nominationTurn:0,sold:[],feed:[],timer:null,userName:'Your Franchise'};
  function S(){return window.auctionDraftState;}
  function E(id){return document.getElementById(id);}
  function T(id,v){var n=E(id);if(n)n.textContent=v;}
  function cash(v){return '$'+Math.max(0,Math.round(v));}
  function esc(v){return typeof escapeDraftText==='function'?escapeDraftText(v):String(v||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function total(team){return team.roster.reduce(function(a,p){return a+Number(p.total||0);},0);}
  function slots(team){return ROSTER-team.roster.length;}
  function spendLimit(team){return Math.max(0,team.budget-Math.max(0,slots(team)-1));}
  function stopTimer(){if(S().timer){clearInterval(S().timer);S().timer=null;}}
  function feed(message,tone){var s=S();s.feed.unshift({message:message,tone:tone||'text-slate-300'});s.feed=s.feed.slice(0,40);renderFeed();}
  function teamsFor(userName){var a=[{id:0,name:userName||'Your Franchise',style:'You',mult:1,user:true,budget:BUDGET,roster:[]}];TEAM_NAMES.forEach(function(x,i){a.push({id:i+1,name:x[0],style:x[1],mult:x[2],user:false,budget:BUDGET,roster:[]});});return a;}
  function needsFactor(team,p){
    if(!team.roster.length)return 1;
    var stats={offense:0,defense:0,rebounds:0,playmaking:0};
    team.roster.forEach(function(x){stats.offense+=(x.ssPpg||0)+(x.ssApg||0)*.55;stats.defense+=(x.ssSpg||0)+(x.ssBpg||0);stats.rebounds+=(x.ssRpg||0);stats.playmaking+=(x.ssApg||0);});
    Object.keys(stats).forEach(function(k){stats[k]/=team.roster.length;});
    var focus=team.style==='Defensive GM'||team.style==='Rim Protector'?'defense':team.style==='Playmaking Specialist'?'playmaking':team.style==='Balanced Builder'?Object.keys(stats).sort(function(a,b){return stats[a]-stats[b];})[0]:'offense';
    var val=focus==='offense'?(p.ssPpg||0)+(p.ssApg||0)*.55:focus==='defense'?(p.ssSpg||0)+(p.ssBpg||0):focus==='rebounds'?(p.ssRpg||0):(p.ssApg||0);
    return val>stats[focus]?1.08:.96;
  }
  function ceiling(team,p){return Math.min(spendLimit(team),Math.max(1,Math.round(Number(p.total||0)*2.35*team.mult*needsFactor(team,p))));}
  function screen(which){
    ['draft-setup-screen','draft-live-screen','draft-results-screen','auction-live-screen','auction-results-screen'].forEach(function(id){
      var n=E(id);if(n)n.classList.toggle('hidden',id!==(which==='live'?'auction-live-screen':which==='results'?'auction-results-screen':'draft-setup-screen'));
    });
  }
  function startAuctionDraft(){
    var pool=typeof getDraftPool==='function'?getDraftPool():[];
    if(!pool||pool.length<24){alert('The live 2026–27 player pool is not ready yet. Wait for the leaderboard to load, then try again.');return;}
    stopTimer();
    var s=S(), input=E('auction-user-team-name');
    s.userName=input&&input.value.trim()?input.value.trim().slice(0,26):'Your Franchise';
    s.active=true;s.finished=false;s.teams=teamsFor(s.userName);
    s.pool=pool.slice().sort(function(a,b){return Number(b.total)-Number(a.total);});
    s.selectedName='';s.current=null;s.nominationTurn=0;s.sold=[];s.feed=[];
    if(E('auction-search'))E('auction-search').value='';
    screen('live');feed('The auction is open. All 12 franchises start with $200.','text-emerald-300');
    renderAuctionDraft();nextNomination();
  }
  function resetAuctionDraft(){stopTimer();var s=S();s.active=false;s.finished=false;s.current=null;s.teams=[];s.pool=[];s.sold=[];s.feed=[];s.selectedName='';screen('setup');}
  function selectAuctionPlayerByIndex(i){var p=S().pool[i];if(p)selectAuctionPlayer(p.name);}
  function selectAuctionPlayer(name){var s=S();if(!s.active||s.finished||s.current||s.nominationTurn%12!==0)return;s.selectedName=name;renderAuctionPool();}
  function renderAuctionPool(){
    var s=S(),box=E('auction-player-list');if(!box)return;
    var q=(E('auction-search')&&E('auction-search').value||'').toLowerCase().trim();
    var list=s.pool.filter(function(p){return !q||String(p.name).toLowerCase().includes(q)||String(p.team||'').toLowerCase().includes(q);});
    T('auction-pool-count',list.length+' available');
    box.innerHTML=list.slice(0,100).map(function(p,i){var selected=p.name===s.selectedName;return '<button type="button" onclick="selectAuctionPlayerByIndex('+s.pool.indexOf(p)+')" class="w-full text-left rounded-lg border px-2 py-2 flex items-center gap-2 '+(selected?'border-emerald-400 bg-emerald-500/15':'border-transparent bg-court-900 hover:bg-court-800')+'"><span class="text-[9px] text-slate-500 w-5 text-right">'+(i+1)+'</span><span class="min-w-0 flex-1"><b class="block text-xs text-white truncate">'+esc(p.name)+'</b><span class="block text-[9px] text-slate-500 truncate">'+esc(p.team||'NBA')+' · '+Number(p.ppg||0).toFixed(1)+' PTS</span></span><b class="text-xs text-emerald-300">'+Number(p.total||0).toFixed(2)+'</b></button>';}).join('')||'<div class="text-center text-xs text-slate-500 py-6">No players found.</div>';
    if(list.length>100)box.innerHTML+='<div class="text-center text-[9px] text-slate-500 py-2">Showing 100 · search to find more</div>';
    var b=E('auction-nominate-btn');if(b)b.disabled=!s.selectedName||!!s.current||s.nominationTurn%12!==0;
  }
  function renderFeed(){var box=E('auction-feed');if(box)box.innerHTML=S().feed.map(function(x){return '<div class="border-b border-court-border/50 py-1 '+x.tone+'">'+x.message+'</div>';}).join('');}
  function renderTeams(){
    var box=E('auction-team-board');if(!box)return;
    var list=S().teams.slice().sort(function(a,b){return total(b)-total(a);});
    box.innerHTML=list.map(function(t,i){return '<div class="rounded-lg border px-2 py-2 '+(t.user?'border-emerald-500/40 bg-emerald-500/10':'border-court-border bg-court-900/80')+'"><div class="flex items-center justify-between gap-1"><span class="text-[10px] font-bold truncate '+(t.user?'text-emerald-300':'text-slate-200')+'">'+(i+1)+'. '+esc(t.name)+'</span><b class="text-[10px] text-emerald-300">'+total(t).toFixed(1)+'</b></div><div class="flex justify-between gap-1 mt-1 text-[9px] text-slate-500"><span>'+cash(t.budget)+' left</span><span>'+t.roster.length+'/12 players</span></div><div class="h-1 rounded-full bg-court-800 mt-1 overflow-hidden"><div class="h-full bg-emerald-500" style="width:'+(t.roster.length/12*100)+'%"></div></div></div>';}).join('');
  }
  function renderAuctionDraft(){
    var s=S();if(!s.active)return;var user=s.teams[0];
    T('auction-progress',s.sold.length+' / 144');var bar=E('auction-progress-bar');if(bar)bar.style.width=(s.sold.length/144*100)+'%';
    T('auction-user-budget',cash(user.budget));T('auction-user-roster-count',user.roster.length+' / 12');T('auction-user-score',total(user).toFixed(2));
    renderAuctionPool();renderTeams();renderFeed();
    var nom=E('auction-nomination-panel'),stage=E('auction-player-stage'),cur=s.current;
    if(!cur){
      if(nom)nom.classList.remove('hidden');if(stage)stage.classList.add('hidden');
      var n=s.teams[s.nominationTurn%12];T('auction-nominator',n.user?'Your turn to nominate':n.name+' is nominating');
      T('auction-nomination-help',n.user?'Choose any available player. Your nomination opens at $1.':'The AI is selecting a player for the next auction.');
      var skip=E('auction-skip-nomination');if(skip)skip.classList.toggle('hidden',!n.user);
      var b=E('auction-nominate-btn');if(b)b.disabled=!n.user||!s.selectedName;
      return;
    }
    if(nom)nom.classList.add('hidden');if(stage)stage.classList.remove('hidden');
    var p=cur.player;T('auction-player-name',p.name);T('auction-player-meta',(p.team||'NBA')+' · Rank #'+(p.rank||'—')+' · Schrift Score '+Number(p.total).toFixed(2));
    T('auction-pts',Number(p.ppg||0).toFixed(1));T('auction-reb',Number(p.rpg||0).toFixed(1));T('auction-ast',Number(p.apg||0).toFixed(1));T('auction-stl',Number(p.spg||0).toFixed(1));T('auction-blk',Number(p.bpg||0).toFixed(1));
    T('auction-current-bid',cash(cur.bid));T('auction-high-bidder','Leading: '+s.teams[cur.highTeam].name);
    var can=user.roster.length<12&&cur.highTeam!==0&&spendLimit(user)>=cur.bid+1;
    [1,5,10].forEach(function(step){var b=document.querySelector('#auction-player-stage button[onclick="placeAuctionBid('+step+')"]');if(b){b.disabled=!can||cur.bid+step>spendLimit(user);b.classList.toggle('opacity-40',b.disabled);}});
    T('auction-bid-message',cur.highTeam===0?'You are leading. Protect your bid.':'Raise the bid to take the lead.');
  }
  function nextNomination(){
    var s=S();if(s.finished)return;
    if(s.teams.every(function(t){return t.roster.length>=12;})||!s.pool.length){finishAuctionDraft();return;}
    var attempts=0;while(s.teams[s.nominationTurn%12].roster.length>=12&&attempts<12){s.nominationTurn++;attempts++;}
    if(s.teams.every(function(t){return t.roster.length>=12;})){finishAuctionDraft();return;}
    var n=s.teams[s.nominationTurn%12];s.selectedName='';if(E('auction-search'))E('auction-search').value='';renderAuctionDraft();
    if(!n.user){T('auction-feed-status','AI NOMINATION');setTimeout(function(){if(!s.active||s.current||s.finished)return;var p=chooseNomination(n);if(p)beginAuction(p,n.id);},700);}
    else{T('auction-feed-status','YOUR NOMINATION');feed('Your nomination is up. Put a player on the block.','text-emerald-300');}
  }
  function chooseNomination(team){
    var pool=S().pool.slice(0,80);if(!pool.length)return null;
    return pool.map(function(p){var value=ceiling(team,p);return {p:p,priority:Number(p.total||0)+value*.08+Math.random()*1.5};}).sort(function(a,b){return b.priority-a.priority;})[0].p;
  }
  function nominateAuctionPlayer(){var s=S();if(!s.active||s.current||s.nominationTurn%12!==0||s.teams[0].roster.length>=12)return;var p=s.pool.find(function(x){return x.name===s.selectedName;});if(p)beginAuction(p,0);}
  function autoNominateForUser(){var s=S();if(!s.active||s.current||s.nominationTurn%12!==0)return;var p=chooseNomination(s.teams[0]);if(p)beginAuction(p,0);}
  function beginAuction(player,nominator){
    var s=S(),team=s.teams[nominator];if(!player||s.current||!team||team.roster.length>=12||!s.pool.some(function(p){return p.name===player.name;}))return;
    s.selectedName='';s.current={player:player,bid:1,highTeam:nominator,deadline:Date.now()+8000,nextAiAt:Date.now()+900};
    feed('<b>'+esc(team.name)+'</b> nominates <b>'+esc(player.name)+'</b> at $1.','text-amber-200');renderAuctionDraft();
    stopTimer();s.timer=setInterval(function(){
      var c=s.current;if(!s.active||!c){stopTimer();return;}
      var left=Math.max(0,Math.ceil((c.deadline-Date.now())/1000));T('auction-countdown',left);
      if(left<=0){closeAuction();return;}
      if(Date.now()>=c.nextAiAt){c.nextAiAt=Date.now()+1000;aiBid();}
    },250);
  }
  function aiBid(){
    var s=S(),c=s.current;if(!c)return;
    var candidates=s.teams.filter(function(t){return !t.user&&t.id!==c.highTeam&&t.roster.length<12&&spendLimit(t)>=c.bid+1&&ceiling(t,c.player)>=c.bid+1;});
    candidates=candidates.filter(function(t){var gap=ceiling(t,c.player)-c.bid;var ag=t.style==='Aggressive GM'?.92:t.style==='Superstar Chaser'?.82:t.style==='Patient GM'?.38:.62;return Math.random()<Math.min(.96,ag+Math.max(0,gap)*.012);});
    if(!candidates.length)return;
    candidates.sort(function(a,b){return ceiling(b,c.player)-ceiling(a,c.player);});
    var bidder=candidates[Math.floor(Math.random()*Math.min(3,candidates.length))];
    var step=bidder.style==='Aggressive GM'||bidder.style==='Superstar Chaser'?2:1;
    var bid=Math.min(c.bid+step,ceiling(bidder,c.player),spendLimit(bidder));if(bid<=c.bid)return;
    c.bid=bid;c.highTeam=bidder.id;c.deadline=Date.now()+6500;
    feed('<b>'+esc(bidder.name)+'</b> bids <b>'+cash(bid)+'</b> for '+esc(c.player.name)+'.','text-amber-200');renderAuctionDraft();
  }
  function placeAuctionBid(increment){
    var s=S(),c=s.current,user=s.teams[0];if(!c||c.highTeam===0||user.roster.length>=12)return;
    var bid=c.bid+Number(increment||1);if(bid>spendLimit(user)){T('auction-bid-message','Keep enough money for the rest of your roster.');return;}
    c.bid=bid;c.highTeam=0;c.deadline=Date.now()+6500;feed('You bid <b>'+cash(bid)+'</b> for '+esc(c.player.name)+'.','text-emerald-300');renderAuctionDraft();
  }
  function closeAuction(){
    var s=S(),c=s.current;if(!c)return;stopTimer();
    var winner=s.teams[c.highTeam];winner.budget-=c.bid;winner.roster.push(c.player);
    s.pool=s.pool.filter(function(p){return p.name!==c.player.name;});
    s.sold.push({player:c.player,price:c.bid,teamId:winner.id,nominator:s.nominationTurn%12});
    feed('<b>SOLD:</b> '+esc(c.player.name)+' to <b>'+esc(winner.name)+'</b> for <b>'+cash(c.bid)+'</b>.',winner.user?'text-emerald-300':'text-amber-200');
    s.current=null;s.nominationTurn++;renderAuctionDraft();
    if(s.teams.every(function(t){return t.roster.length>=12;})||!s.pool.length){finishAuctionDraft();return;}
    setTimeout(nextNomination,800);
  }
  function finishAuctionDraft(){var s=S();stopTimer();s.finished=true;s.active=true;screen('results');renderAuctionResults();}
  function grade(rank){return ['A+','A','A-','B+','B','B-','C+','C','C-','D','D-','F'][Math.max(0,Math.min(11,rank-1))];}
  function renderAuctionResults(){
    var s=S(),standings=s.teams.map(function(t){return {team:t,total:total(t),spent:BUDGET-t.budget};}).sort(function(a,b){return b.total-a.total;});
    var rank=standings.findIndex(function(x){return x.team.user;})+1,user=standings.find(function(x){return x.team.user;}),winner=standings[0];
    var banner=E('auction-result-banner');if(banner){banner.className='rounded-2xl border p-5 text-center '+(rank===1?'border-emerald-500/40 bg-emerald-500/10':'border-amber-500/30 bg-court-900');banner.innerHTML='<div class="text-2xl font-black '+(rank===1?'text-emerald-300':'text-white')+'">'+(rank===1?'YOU WON THE AUCTION DRAFT':esc(winner.team.name)+' wins the draft')+'</div><div class="text-sm text-slate-300 mt-1">Your finish: #'+rank+' · '+user.total.toFixed(2)+' total Schrift Score · '+grade(rank)+' grade</div>';}
    T('auction-result-sub','12-team auction · $200 starting budget · ranked by total roster Schrift Score');
    var summary=E('auction-result-summary');if(summary)summary.innerHTML=[['YOUR FINISH','#'+rank+' · '+grade(rank)],['YOUR TOTAL SS',user.total.toFixed(2)],['YOUR SPENDING',cash(user.spent)+' · '+cash(user.team.budget)+' left']].map(function(x){return '<div class="rounded-xl border border-court-border bg-court-900 p-3"><div class="text-[9px] text-slate-500 uppercase">'+x[0]+'</div><div class="text-xl font-black text-white mt-1">'+x[1]+'</div></div>';}).join('');
    var rankings=E('auction-result-rankings');if(rankings)rankings.innerHTML=standings.map(function(x,i){return '<div class="flex items-center justify-between gap-2 rounded-lg px-2 py-2 '+(x.team.user?'bg-emerald-500/10 border border-emerald-500/30':'bg-court-950/50')+'"><span class="text-xs text-slate-200"><b class="text-slate-500 mr-2">#'+(i+1)+'</b>'+esc(x.team.name)+(x.team.user?' <b class="text-emerald-300">(YOU)</b>':'')+'</span><span class="text-right"><b class="text-sm text-emerald-300">'+x.total.toFixed(2)+'</b><span class="block text-[9px] text-slate-500">'+cash(x.spent)+' spent · '+x.team.roster.length+' players · '+grade(i+1)+'</span></span></div>';}).join('');
    var roster=E('auction-result-roster');if(roster)roster.innerHTML=user.team.roster.slice().sort(function(a,b){return b.total-a.total;}).map(function(p){var sale=s.sold.find(function(x){return x.player.name===p.name;});return '<div class="flex justify-between gap-2 border-b border-court-border/60 py-1"><span class="truncate">'+esc(p.name)+' <span class="text-slate-500">('+Number(p.total).toFixed(2)+' SS)</span></span><b class="text-emerald-300">'+cash(sale?sale.price:0)+'</b></div>';}).join('');
    var awards=E('auction-result-awards');if(awards){var best=s.sold.slice().sort(function(a,b){return b.player.total-a.player.total;})[0];var bargain=s.sold.slice().sort(function(a,b){return b.player.total/Math.max(1,b.price)-a.player.total/Math.max(1,a.price);})[0];var overpay=s.sold.slice().sort(function(a,b){return b.price/Math.max(1,b.player.total)-a.price/Math.max(1,a.player.total);})[0];awards.innerHTML=[['Highest Schrift Score',best?best.player.name+' · '+best.player.total.toFixed(2)+' SS':'—'],['Best bargain',bargain?bargain.player.name+' · '+cash(bargain.price):'—'],['Biggest overpay',overpay?overpay.player.name+' · '+cash(overpay.price):'—']].map(function(x){return '<div><div class="text-[9px] uppercase text-slate-500">'+x[0]+'</div><b class="text-slate-200">'+esc(x[1])+'</b></div>';}).join('');}
  }
  window.startAuctionDraft=startAuctionDraft;window.resetAuctionDraft=resetAuctionDraft;
  window.selectAuctionPlayerByIndex=selectAuctionPlayerByIndex;window.renderAuctionPool=renderAuctionPool;
  window.nominateAuctionPlayer=nominateAuctionPlayer;window.autoNominateForUser=autoNominateForUser;
  window.placeAuctionBid=placeAuctionBid;window.showAuctionDraftScreen=screen;window.renderAuctionDraft=renderAuctionDraft;
})();