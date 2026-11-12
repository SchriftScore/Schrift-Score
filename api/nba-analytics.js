// Game-level analytics sourced only from Basketball-Reference via API.SH.
// Returns the current 2026-27 season once; the browser applies 7/14/30-day windows locally.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const apiKey = process.env.APISH_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Basketball-Reference data is not configured. Add APISH_API_KEY to Vercel Preview.' });
  }

  const seasonStart = '2026-10-21';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const startDate = new Date(seasonStart + 'T12:00:00Z');
  const endDate = new Date(today + 'T12:00:00Z');
  const dayKeys = [];
  for (const day = new Date(startDate); day <= endDate; day.setUTCDate(day.getUTCDate() + 1)) {
    dayKeys.push(day.toISOString().slice(0, 10));
  }

  const apiGet = async (path, params) => {
    const url = new URL('https://api.api.sh/basketball-reference/v1/' + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || ('API.SH ' + path + ' returned HTTP ' + response.status));
    }
    return payload;
  };

  const tablesOf = payload => {
    if (Array.isArray(payload.tables)) return payload.tables;
    if (payload.tables && typeof payload.tables === 'object') return Object.values(payload.tables);
    return [];
  };
  const num = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const teamAbbr = team => {
    const path = String(team.url || '');
    const marker = '/teams/';
    const start = path.indexOf(marker);
    if (start >= 0) return path.slice(start + marker.length, start + marker.length + 3).toUpperCase();
    return String(team.abbreviation || team.team_id || '');
  };
  const boxIdFromUrl = value => {
    const parts = String(value || '').split('/boxscores/');
    if (parts.length < 2) return '';
    return parts[1].split(/[?#]/)[0].replace('.html', '');
  };

  try {
    // Fetch the Basketball-Reference daily scores index for every date in the season.
    const dailyPayloads = await Promise.all(dayKeys.map(date => apiGet('scores', { date })));
    const descriptors = [];
    for (let index = 0; index < dailyPayloads.length; index += 1) {
      const payload = dailyPayloads[index];
      const date = dayKeys[index];
      const dayGames = Array.isArray(payload.games) ? payload.games : [];
      for (const game of dayGames) {
        const gameTeams = Array.isArray(game.teams) ? game.teams : [];
        const teamWithBoxLink = gameTeams.find(team => team.boxscore_url);
        const boxscoreUrl = game.boxscore_url || game.boxscoreUrl || (teamWithBoxLink && teamWithBoxLink.boxscore_url) || '';
        const boxId = boxIdFromUrl(boxscoreUrl) || boxIdFromUrl(game.url);
        if (!boxId) throw new Error('Basketball-Reference listed a game without a box-score link.');
        descriptors.push({ date, boxId, teams: gameTeams });
      }
    }

    const games = [];
    const concurrency = 8;
    const workerCount = Math.min(concurrency, descriptors.length);
    const workers = Array.from({ length: workerCount }, async (_, worker) => {
      for (let index = worker; index < descriptors.length; index += workerCount) {
        const descriptor = descriptors[index];
        const payload = await apiGet('boxscore', { id: descriptor.boxId });
        const tables = tablesOf(payload);
        const basicTables = tables.filter(table => {
          const id = String(table.id || '');
          const rows = Array.isArray(table.rows) ? table.rows : [];
          return id.includes('game-basic') || rows.some(row =>
            row.player !== undefined && (row.pts !== undefined || row.mp !== undefined)
          );
        });
        const selectedTables = basicTables.length ? basicTables : tables;
        const homeAbbr = descriptor.boxId.slice(-3).toUpperCase();
        const teamInfo = descriptor.teams.map(team => ({
          abbr: teamAbbr(team),
          score: num(team.score !== undefined ? team.score : team.pts),
          name: team.name || team.team || teamAbbr(team)
        }));
        const home = teamInfo.find(team => team.abbr === homeAbbr) || teamInfo[1] || {};
        const away = teamInfo.find(team => team.abbr && team.abbr !== homeAbbr) || teamInfo[0] || {};
        if (teamInfo.length < 2) {
          throw new Error('Basketball-Reference score response omitted a game’s two teams.');
        }

        for (const table of selectedTables) {
          const tableId = String(table.id || '');
          const tableMarker = tableId.indexOf('box-');
          const tableTeam = tableMarker >= 0 ? tableId.slice(tableMarker + 4, tableMarker + 7).toUpperCase() : '';
          const rows = Array.isArray(table.rows) ? table.rows : [];
          for (const row of rows) {
            const name = String(row.player || row.name || '').trim();
            if (!name || ['team totals', 'reserves', 'starters'].includes(name.toLowerCase())) continue;
            const team = tableTeam || String(row.team_id || '');
            if (!team) continue;
            const pts = num(row.pts);
            const reb = num(row.trb !== undefined ? row.trb : row.reb);
            const ast = num(row.ast);
            const stl = num(row.stl);
            const blk = num(row.blk);
            const minutes = row.mp !== undefined ? row.mp : (row.minutes || '');
            if (!minutes && !pts && !reb && !ast && !stl && !blk) continue;
            const ss = pts * 0.35 + reb * 0.83 + ast * 1.14 + stl * 1.80 + blk * 1.98 + 0.04;
            const isHome = team === homeAbbr;
            const own = isHome ? home : away;
            const opponent = isHome ? away : home;
            games.push({
              name,
              team,
              date: descriptor.date,
              eventId: descriptor.boxId,
              opponent: opponent.abbr || opponent.name || '—',
              homeAway: isHome ? 'home' : 'away',
              result: own.score > opponent.score ? 'W' : 'L',
              pts, reb, ast, stl, blk, ss,
              minutes: minutes || '—'
            });
          }
        }
      }
    });
    if (workers.length) await Promise.all(workers);
    if (!games.length && descriptors.length) {
      throw new Error('Basketball-Reference box scores did not contain usable player lines.');
    }
    games.sort((a, b) => b.date.localeCompare(a.date));
    return res.status(200).json({
      source: 'Basketball-Reference',
      retrieval: 'API.SH',
      window: 'season',
      startDate: seasonStart,
      endDate: today,
      games,
      gameCount: descriptors.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Basketball-Reference game analytics feed failed:', error);
    return res.status(502).json({
      error: 'Basketball-Reference game-level data could not be retrieved through API.SH. No ESPN or other substitute data was used.'
    });
  }
}
