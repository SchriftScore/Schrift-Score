// Game-level analytics sourced only from Basketball-Reference via API.SH.
// Returns the current 2026-27 season once; the browser applies 7/14/30-day windows locally.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const apiKey = process.env.APISH_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Basketball-Reference data is not configured. Add APISH_API_KEY to Vercel Preview.' });

  const seasonStart = '2026-10-21';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const startDate = new Date(seasonStart + 'T12:00:00Z');
  const endDate = new Date(today + 'T12:00:00Z');
  const dayKeys = [];
  for (const day = new Date(startDate); day <= endDate; day.setUTCDate(day.getUTCDate() + 1)) {
    dayKeys.push(day.toISOString().slice(0, 10));
  }

  const apiGet = async (path, params) => {
    const url = new URL('https://api.api.sh/basketball-reference/v1/' + path);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || ('API.SH ' + path + ' returned HTTP ' + response.status));
    return payload;
  };
  const tablesOf = payload => Array.isArray(payload?.tables)
    ? payload.tables
    : payload?.tables && typeof payload.tables === 'object' ? Object.values(payload.tables) : [];
  const num = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const teamAbbr = team => {
    const match = String(team?.url || '').match(/\/teams\/([A-Z]{3})\//i);
    return match?.[1]?.toUpperCase() || String(team?.abbreviation || team?.team_id || '');
  };
  const boxIdFromUrl = value => String(value || '').match(/boxscores\/([^/?#]+?)(?:\.html)?(?:[?#]|$)/i)?.[1] || '';

  try {
    // Fetch the Basketball-Reference daily scores index for each date in the season.
    const dailyPayloads = await Promise.all(dayKeys.map(date => apiGet('scores', { date })));
    const descriptors = [];
    dailyPayloads.forEach((payload, index) => {
      const date = dayKeys[index];
      for (const game of Array.isArray(payload.games) ? payload.games : []) {
        const boxscoreUrl = game.boxscore_url || game.boxscoreUrl ||
          (Array.isArray(game.teams) ? game.teams.find(team => team.boxscore_url)?.boxscore_url : '');
        const boxId = boxIdFromUrl(boxscoreUrl) || boxIdFromUrl(game.url);
        if (!boxId) throw new Error('Basketball-Reference listed a game without a box-score link.');
        descriptors.push({ date, boxId, teams: Array.isArray(game.teams) ? game.teams : [] });
      }
    });

    const games = [];
    const concurrency = 8;
    const workers = Array.from({ length: Math.min(concurrency, descriptors.length) }, async (_, worker) => {
      for (let index = worker; index < descriptors.length; index += Math.min(concurrency, descriptors.length)) {
        const descriptor = descriptors[index];
        const payload = await apiGet('boxscore', { id: descriptor.boxId });
        const tables = tablesOf(payload);
        const basicTables = tables.filter(table =>
          String(table?.id || '').includes('game-basic') ||
          (Array.isArray(table?.rows) && table.rows.some(row => row?.player !== undefined && (row?.pts !== undefined || row?.mp !== undefined)))
        );
        const selectedTables = basicTables.length ? basicTables : tables;
        const homeAbbr = descriptor.boxId.slice(-3).toUpperCase();
        const teams = descriptor.teams;
        const teamInfo = teams.map(team => ({
          abbr: teamAbbr(team),
          score: num(team?.score ?? team?.pts),
          name: team?.name || team?.team || teamAbbr(team)
        }));
        const home = teamInfo.find(team => team.abbr === homeAbbr) || teamInfo[1] || {};
        const away = teamInfo.find(team => team.abbr && team.abbr !== homeAbbr) || teamInfo[0] || {};
        if (teamInfo.length < 2) throw new Error('Basketball-Reference score response omitted a game's two teams.');

        for (const table of selectedTables) {
          const tableId = String(table?.id || '');
          const tableTeam = tableId.match(/box-([A-Z]{3})-/i)?.[1]?.toUpperCase() || '';
          for (const row of Array.isArray(table?.rows) ? table.rows : []) {
            const name = String(row?.player || row?.name || '').trim();
            if (!name || /^(team totals|reserves|starters)$/i.test(name)) continue;
            const team = tableTeam || String(row?.team_id || '');
            if (!team) continue;
            const pts = num(row?.pts);
            const reb = num(row?.trb ?? row?.reb);
            const ast = num(row?.ast);
            const stl = num(row?.stl);
            const blk = num(row?.blk);
            const minutes = row?.mp ?? row?.minutes ?? '';
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
