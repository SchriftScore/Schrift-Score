// Season-wide NBA player game logs using ESPN's public scoreboard and summary feeds.
// No API key or paid data provider is required.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  const seasonStart = '2026-10-20';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const dayKeys = [];
  for (const day = new Date(seasonStart + 'T12:00:00Z'); day <= new Date(today + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    dayKeys.push(day.toISOString().slice(0, 10));
  }
  const getJson = async url => {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'SchriftScore/1.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error('ESPN returned HTTP ' + response.status);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * attempt));
      }
    }
    throw lastError;
  };
  const num = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dataQuality = { scoreboardFailures: [], boxScoreFailures: [], invalidBoxScores: [] };
  const scoreWorkers = async (items, count, fn) => {
    const workers = Array.from({length: Math.min(count, items.length)}, async (_, worker) => {
      for (let i = worker; i < items.length; i += Math.min(count, items.length)) await fn(items[i], i);
    });
    await Promise.all(workers);
  };

  try {
    const dailyPayloads = new Array(dayKeys.length);
    await scoreWorkers(dayKeys, 4, async (date, index) => {
      const compactDate = date.replace(/-/g, '');
      try {
        dailyPayloads[index] = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + compactDate + '&limit=100');
      } catch (error) {
        dataQuality.scoreboardFailures.push({ date, error: error?.message || 'Unknown ESPN error' });
      }
    });

    const gamesById = new Map();
    for (let i = 0; i < dailyPayloads.length; i++) {
      for (const event of dailyPayloads[i]?.events || []) {
        const competition = event.competitions?.[0];
        if (!competition?.status?.type?.completed) continue;
        if (!event.id || gamesById.has(event.id)) continue;
        const competitors = competition.competitors || [];
        const away = competitors.find(team => team.homeAway === 'away');
        const home = competitors.find(team => team.homeAway === 'home');
        if (!away || !home) continue;
        gamesById.set(event.id, {
          eventId: event.id, date: dayKeys[i],
          awayTeam: away.team?.abbreviation || '—', homeTeam: home.team?.abbreviation || '—',
          awayScore: num(away.score), homeScore: num(home.score)
        });
      }
    }

    const descriptors = [...gamesById.values()];
    const games = [];
    const seen = new Set();
    await scoreWorkers(descriptors, 10, async game => {
      try {
      const summary = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=' + encodeURIComponent(game.eventId));
      const teamBlocks = summary.boxscore?.players || [];
      if (!teamBlocks.length) throw new Error('ESPN returned no player box score for game ' + game.eventId);
      const requiredStats = ['MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK'];
      const validGroups = teamBlocks.flatMap(block => block.statistics || []).filter(group =>
        requiredStats.every(key => (group.labels || []).some(label => String(label).toUpperCase() === key))
      );
      if (!validGroups.length) throw new Error('ESPN box score is missing required player statistics for game ' + game.eventId);
      for (const teamBlock of teamBlocks) {
        const team = teamBlock.team?.abbreviation || '';
        if (!team) continue;
        const isHome = team === game.homeTeam;
        const opponent = isHome ? game.awayTeam : game.homeTeam;
        const ownScore = isHome ? game.homeScore : game.awayScore;
        const opponentScore = isHome ? game.awayScore : game.homeScore;
        for (const group of teamBlock.statistics || []) {
          const labels = group.labels || [];
          if (!requiredStats.every(key => labels.some(label => String(label).toUpperCase() === key))) continue;
          const indexOf = key => labels.findIndex(label => String(label).toUpperCase() === key);
          for (const row of group.athletes || []) {
            const athlete = row.athlete;
            if (!athlete) continue;
            const vals = row.stats || [];
            const get = key => {
              const idx = indexOf(key);
              return idx >= 0 ? vals[idx] : 0;
            };
            const minutes = get('MIN');
            const minuteText = String(minutes ?? '').trim();
            if (!/^\d+(?::[0-5]\d)?(?:\.\d+)?$/.test(minuteText)) continue;
            const minuteParts = minuteText.split(':').map(Number);
            const playedMinutes = minuteParts.length === 2 ? minuteParts[0] + minuteParts[1] / 60 : Number(minuteText);
            if (!Number.isFinite(playedMinutes) || playedMinutes <= 0 || playedMinutes > 65) continue;
            const name = athlete.displayName || athlete.fullName || athlete.shortName;
            if (!name) continue;
            const key = game.eventId + '|' + team + '|' + normalizeName(name);
            if (seen.has(key)) continue;
            seen.add(key);
            const pts = num(get('PTS')), reb = num(get('REB')), ast = num(get('AST'));
            const stl = num(get('STL')), blk = num(get('BLK'));
            games.push({
              name, team, playerId: athlete.id ? String(athlete.id) : '', date: game.date, eventId: game.eventId,
              opponent, homeAway: isHome ? 'home' : 'away',
              result: ownScore > opponentScore ? 'W' : 'L',
              teamScore: ownScore, opponentScore,
              pts, reb, ast, stl, blk,
              ss: pts * 0.35 + reb * 0.83 + ast * 1.14 + stl * 1.80 + blk * 1.98 + 0.04,
              minutes: minuteText
            });
          }
        }
      }
      } catch (error) {
        dataQuality.boxScoreFailures.push({ eventId: game.eventId, date: game.date, error: error?.message || 'Unknown ESPN error' });
      }
    });

    if (!dailyPayloads.some(Boolean) && dataQuality.scoreboardFailures.length) {
      throw new Error('ESPN scoreboard requests failed for every date in the requested season window.');
    }
    if (descriptors.length && !games.length) throw new Error('ESPN returned no valid player game lines.');
    games.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));

    // Build the season leaderboard from the exact same completed-game box scores.
    // This keeps the leaderboard and player profiles on one consistent data source.
    const playerMap = new Map();
    for (const game of games) {
      const key = normalizeName(game.name);
      if (!playerMap.has(key)) playerMap.set(key, {
        name: game.name, team: game.team, playerId: game.playerId || '', gp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0,
        lastGameDate: ''
      });
      const player = playerMap.get(key);
      player.gp += 1;
      player.pts += game.pts; player.reb += game.reb; player.ast += game.ast;
      player.stl += game.stl; player.blk += game.blk;
      if (game.date >= player.lastGameDate) {
        player.team = game.team;
        if (game.playerId) player.playerId = game.playerId;
        player.lastGameDate = game.date;
      }
    }
    const weights = { ppg: 0.35, rpg: 0.83, apg: 1.14, spg: 1.80, bpg: 1.98, gp: 0.04 };
    let players = [...playerMap.values()].map(player => {
      // Schrift Score is calculated from the same one-decimal averages shown in the leaderboard.
      const ppg = Number((player.pts / player.gp).toFixed(1));
      const rpg = Number((player.reb / player.gp).toFixed(1));
      const apg = Number((player.ast / player.gp).toFixed(1));
      const spg = Number((player.stl / player.gp).toFixed(1));
      const bpg = Number((player.blk / player.gp).toFixed(1));
      const ssPpg = ppg * weights.ppg, ssRpg = rpg * weights.rpg;
      const ssApg = apg * weights.apg, ssSpg = spg * weights.spg, ssBpg = bpg * weights.bpg;
      const ssGp = player.gp * weights.gp;
      return {
        name: player.name, team: player.team, playerId: player.playerId || '', gp: player.gp,
        ppg, rpg, apg, spg, bpg, ssPpg, ssRpg, ssApg, ssSpg, ssBpg, ssGp,
        total: ssPpg + ssRpg + ssApg + ssSpg + ssBpg + ssGp
      };
    }).sort((a, b) => b.total - a.total).map((player, index) => ({ ...player, rank: index + 1 }));

    // Compare today's leaderboard with the standings immediately before the
    // latest completed game date. This makes rank movement a real day-over-day
    // comparison instead of defaulting every player to zero.
    const latestGameDate = games.reduce((latest, game) => game.date > latest ? game.date : latest, '');
    const priorTotals = new Map();
    for (const game of games) {
      if (!latestGameDate || game.date >= latestGameDate) continue;
      const key = normalizeName(game.name);
      if (!priorTotals.has(key)) priorTotals.set(key, { gp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 });
      const prior = priorTotals.get(key);
      prior.gp += 1;
      prior.pts += game.pts; prior.reb += game.reb; prior.ast += game.ast;
      prior.stl += game.stl; prior.blk += game.blk;
    }
    const priorRankByName = new Map([...priorTotals.entries()]
      .map(([key, p]) => {
        const score = Number((p.pts / p.gp).toFixed(1)) * weights.ppg
          + Number((p.reb / p.gp).toFixed(1)) * weights.rpg
          + Number((p.ast / p.gp).toFixed(1)) * weights.apg
          + Number((p.stl / p.gp).toFixed(1)) * weights.spg
          + Number((p.blk / p.gp).toFixed(1)) * weights.bpg
          + p.gp * weights.gp;
        return { key, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((p, index) => [p.key, index + 1]));
    players = players.map(player => {
      const priorRank = priorRankByName.get(normalizeName(player.name));
      return {
        ...player,
        rankYesterday: priorRank ?? null,
        rankChange: priorRank == null ? null : priorRank - player.rank
      };
    });

    return res.status(200).json({
      source: 'ESPN', retrieval: 'ESPN public scoreboard and box-score feeds',
      window: 'season', startDate: seasonStart, endDate: today,
      games, players, count: players.length,
      gameCount: descriptors.length, playerGameLineCount: games.length,
      dataQuality: {
        partial: dataQuality.scoreboardFailures.length > 0 || dataQuality.boxScoreFailures.length > 0,
        requestedDates: dayKeys.length,
        scoreboardFailureCount: dataQuality.scoreboardFailures.length,
        boxScoreFailureCount: dataQuality.boxScoreFailures.length,
        scoreboardFailures: dataQuality.scoreboardFailures,
        boxScoreFailures: dataQuality.boxScoreFailures
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('SchriftScore ESPN analytics feed failed:', error);
    return res.status(502).json({
      error: 'NBA game-level data could not be retrieved from ESPN: ' + (error?.message || 'Unknown upstream error')
    });
  }
}
