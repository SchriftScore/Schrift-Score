export const config = { maxDuration: 60 };

// Game-level analytics sourced only from Basketball-Reference via API.SH.
// Parse only the two official basic box-score tables for each completed game.
// Duplicate rows and duplicate game descriptors are rejected before returning data.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  const apiKey = process.env.APISH_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Basketball-Reference data is not configured. Add APISH_API_KEY to the Vercel Production environment and redeploy.' });
  }

  const seasonStart = '2026-10-20';
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const dayKeys = [];
  for (const day = new Date(seasonStart + 'T12:00:00Z'); day <= new Date(today + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    dayKeys.push(day.toISOString().slice(0, 10));
  }

  const apiGet = async (path, params) => {
    const url = new URL('https://api.api.sh/basketball-reference/v1/' + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || ('API.SH ' + path + ' returned HTTP ' + response.status));
    return payload;
  };
  const tablesOf = payload => Array.isArray(payload?.tables)
    ? payload.tables
    : payload?.tables && typeof payload.tables === 'object' ? Object.values(payload.tables) : [];
  const num = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const teamAbbr = team => {
    const match = String(team?.url || '').match(/\/teams\/([A-Z]{3})\//i);
    return match?.[1]?.toUpperCase() || String(team?.abbreviation || team?.team_id || '').toUpperCase();
  };
  const boxIdFromUrl = value => {
    const match = String(value || '').match(/boxscores\/([^/?#]+?)(?:\.html)?(?:[?#]|$)/i);
    return match?.[1] || '';
  };
  const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  try {
    // Keep upstream requests bounded. Fetching every date at once can trigger
    // API.SH rate limits and cause the Vercel function to time out.
    const dailyPayloads = new Array(dayKeys.length);
    const scoreWorkers = Array.from({ length: Math.min(4, dayKeys.length) }, async (_, worker) => {
      for (let index = worker; index < dayKeys.length; index += 4) {
        const date = dayKeys[index];
        dailyPayloads[index] = await apiGet('scores', date === today ? { date, fresh: 1 } : { date });
      }
    });
    await Promise.all(scoreWorkers);
    const descriptorMap = new Map();
    for (let index = 0; index < dailyPayloads.length; index += 1) {
      const date = dayKeys[index];
      const dayGames = Array.isArray(dailyPayloads[index]?.games) ? dailyPayloads[index].games : [];
      for (const game of dayGames) {
        const teams = Array.isArray(game.teams) ? game.teams : [];
        const linkedTeam = teams.find(team => team?.boxscore_url);
        const boxUrl = game.boxscore_url || game.boxscoreUrl || linkedTeam?.boxscore_url || game.url || '';
        const boxId = boxIdFromUrl(boxUrl);
        if (!boxId) {
          const status = String(game.status || game.status_text || '').toLowerCase();
          if (status.includes('final')) throw new Error('Basketball-Reference listed a completed game without a box-score link.');
          continue;
        }
        if (date < seasonStart || date > today) continue;
        if (!descriptorMap.has(boxId)) descriptorMap.set(boxId, { date, boxId, teams });
      }
    }

    const descriptors = [...descriptorMap.values()];
    const games = [];
    const seenPlayerGames = new Set();
    const concurrency = 6;
    const workerCount = Math.min(concurrency, descriptors.length);
    const workers = Array.from({ length: workerCount }, async (_, worker) => {
      for (let index = worker; index < descriptors.length; index += workerCount) {
        const descriptor = descriptors[index];
        const payload = await apiGet('boxscore', { id: descriptor.boxId });
        const tables = tablesOf(payload);
        // Basketball-Reference's basic box score tables have this exact ID shape.
        // Never fall back to advanced, four-factor, or other tables.
        const basicTables = tables.filter(table => /^box-[A-Z]{3}-game-basic$/i.test(String(table?.id || '')));
        const teamInfo = descriptor.teams.map(team => ({
          abbr: teamAbbr(team),
          score: num(team.score !== undefined ? team.score : team.pts),
          name: team.name || team.team || teamAbbr(team)
        }));
        if (basicTables.length !== 2 || teamInfo.length !== 2) {
          throw new Error('Expected exactly two Basketball-Reference basic box-score tables for ' + descriptor.boxId + '.');
        }
        const homeAbbr = descriptor.boxId.slice(-3).toUpperCase();
        const home = teamInfo.find(team => team.abbr === homeAbbr) || teamInfo[1];
        const away = teamInfo.find(team => team.abbr && team.abbr !== homeAbbr) || teamInfo[0];
        if (!home?.abbr || !away?.abbr || home.abbr === away.abbr) {
          throw new Error('Basketball-Reference team identifiers were incomplete for ' + descriptor.boxId + '.');
        }

        for (const table of basicTables) {
          const tableId = String(table.id);
          const tableTeam = tableId.match(/^box-([A-Z]{3})-game-basic$/i)?.[1]?.toUpperCase();
          if (!tableTeam || ![home.abbr, away.abbr].includes(tableTeam)) {
            throw new Error('Unexpected team table in Basketball-Reference box score ' + descriptor.boxId + '.');
          }
          for (const row of Array.isArray(table.rows) ? table.rows : []) {
            const name = String(row?.player || row?.name || '').trim();
            if (!name || /^(team totals|reserves|starters)$/i.test(name)) continue;
            const minutes = row.mp ?? row.minutes ?? '';
            const minuteText = String(minutes).trim();
            const hasMinutes = minuteText !== '' && minuteText !== '0:00' && minuteText !== '0';
            if (!hasMinutes) continue;
            const key = descriptor.boxId + '|' + tableTeam + '|' + normalizeName(name);
            if (seenPlayerGames.has(key)) continue;
            seenPlayerGames.add(key);

            const pts = num(row.pts), reb = num(row.trb ?? row.reb), ast = num(row.ast);
            const stl = num(row.stl), blk = num(row.blk);
            const isHome = tableTeam === home.abbr;
            const own = isHome ? home : away;
            const opponent = isHome ? away : home;
            games.push({
              name, team: tableTeam, date: descriptor.date, eventId: descriptor.boxId,
              opponent: opponent.abbr, homeAway: isHome ? 'home' : 'away',
              result: own.score > opponent.score ? 'W' : 'L',
              pts, reb, ast, stl, blk,
              ss: pts * 0.35 + reb * 0.83 + ast * 1.14 + stl * 1.80 + blk * 1.98 + 0.04,
              minutes
            });
          }
        }
      }
    });
    if (workerCount) await Promise.all(workers);
    if (!games.length && descriptors.length) throw new Error('Basketball-Reference box scores contained no valid player lines.');

    games.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    return res.status(200).json({
      source: 'Basketball-Reference', retrieval: 'API.SH', window: 'season',
      startDate: seasonStart, endDate: today, games,
      gameCount: descriptors.length, playerGameLineCount: games.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Basketball-Reference game analytics feed failed:', error);
    return res.status(502).json({
      error: 'Basketball-Reference game-level data failed validation or could not be retrieved through API.SH. No substitute data was used.'
    });
  }
}
