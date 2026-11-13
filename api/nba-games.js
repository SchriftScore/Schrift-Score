// Yesterday's NBA games and player box scores, sourced only from Basketball-Reference via API.SH.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const rawDate = String(req.query?.date || '');
  if (!/^\d{8}$/.test(rawDate)) return res.status(400).json({ error: 'Use date=YYYYMMDD.' });
  const date = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8);
  const apiKey = process.env.APISH_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Basketball-Reference data is not configured. Add APISH_API_KEY to Vercel Preview.' });

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
  const asNumber = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const boxIdFromUrl = value => {
    const match = String(value || '').match(/boxscores\/([^/?#]+?)(?:\.html)?(?:[?#]|$)/i);
    return match?.[1] || '';
  };
  const teamAbbrFromUrl = value => {
    const match = String(value || '').match(/\/teams\/([A-Z]{3})\//i);
    return match?.[1]?.toUpperCase() || '';
  };

  try {
    const scores = await apiGet('scores', { date });
    const sourceGames = Array.isArray(scores.games) ? scores.games : [];
    if (!sourceGames.length) {
      return res.status(404).json({ error: 'Basketball-Reference reports no NBA games for this date.' });
    }

    const games = await Promise.all(sourceGames.map(async (game, index) => {
      const teams = Array.isArray(game.teams) ? game.teams : [];
      const boxscoreUrl = game.boxscore_url || game.boxscoreUrl || teams.find(team => team.boxscore_url)?.boxscore_url;
      const boxId = boxIdFromUrl(boxscoreUrl) || boxIdFromUrl(game.url);
      if (!boxId) throw new Error('Basketball-Reference did not provide a box-score link for a listed game.');

      const boxPayload = await apiGet('boxscore', { id: boxId });
      const boxTables = tablesOf(boxPayload);
      // Only the two official basic box-score tables contain one player line per appearance.
      // Do not fall back to advanced/four-factor tables: that duplicates players and stats.
      const basicTables = boxTables.filter(table =>
        /^box-[A-Z]{3}-game-basic$/i.test(String(table?.id || ''))
      );
      if (basicTables.length !== 2) {
        throw new Error('Expected exactly two Basketball-Reference basic box-score tables for ' + boxId + '.');
      }
      const box = [];
      const seenPlayers = new Set();
      for (const table of basicTables) {
        const tableTeam = String(table.id).match(/^box-([A-Z]{3})-game-basic$/i)?.[1]?.toUpperCase() || '';
        if (!tableTeam) throw new Error('Missing team identifier in Basketball-Reference box score ' + boxId + '.');
        for (const row of Array.isArray(table?.rows) ? table.rows : []) {
          const name = String(row?.player || row?.name || '').trim();
          if (!name || /^(team totals|reserves|starters)$/i.test(name)) continue;
          const minutes = row?.mp ?? row?.minutes ?? '';
          const hasMinutes = String(minutes).trim() !== '' && String(minutes).trim() !== '0:00' && String(minutes).trim() !== '0';
          if (!hasMinutes) continue;
          const playerKey = name.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (seenPlayers.has(playerKey)) continue;
          seenPlayers.add(playerKey);
          box.push({
            name, tm: tableTeam,
            pts: asNumber(row?.pts),
            reb: asNumber(row?.trb ?? row?.reb),
            ast: asNumber(row?.ast),
            stl: asNumber(row?.stl),
            blk: asNumber(row?.blk),
            min: minutes || '—'
          });
        }
      }
      if (!box.length) throw new Error('Basketball-Reference returned an incomplete box score for ' + boxId + '.');

      const homeAbbr = boxId.slice(-3).toUpperCase();
      const home = teams.find(team => teamAbbrFromUrl(team.url) === homeAbbr) || teams[1] || {};
      const away = teams.find(team => team !== home && teamAbbrFromUrl(team.url) !== homeAbbr) || teams.find(team => team !== home) || teams[0] || {};
      const teamName = team => team.name || team.team || team.abbreviation || '—';
      const teamScore = team => asNumber(team.score ?? team.pts);
      return {
        awayTeam: teamName(away),
        awayScore: teamScore(away),
        homeTeam: teamName(home),
        homeScore: teamScore(home),
        eventId: boxId || String(index),
        dateKey: rawDate,
        box
      };
    }));

    return res.status(200).json({
      source: 'Basketball-Reference',
      retrieval: 'API.SH',
      date: rawDate,
      games
    });
  } catch (error) {
    console.error('Basketball-Reference daily box-score feed failed:', error);
    return res.status(502).json({
      error: 'Basketball-Reference game results or box scores could not be retrieved through API.SH. No ESPN or other substitute data was used.'
    });
  }
}
