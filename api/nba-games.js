// Yesterday's NBA games and player box scores, sourced only from Basketball-Reference via API.SH.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  const rawDate = String(req.query?.date || '');
  if (!/^\\d{8}$/.test(rawDate)) return res.status(400).json({ error: 'Use date=YYYYMMDD.' });
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
    const match = String(value || '').match(/boxscores\\/([^/?#]+?)(?:\\.html)?(?:[?#]|$)/i);
    return match?.[1] || '';
  };
  const teamAbbrFromUrl = value => {
    const match = String(value || '').match(/\\/teams\\/([A-Z]{3})\\//i);
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
      const basicTables = boxTables.filter(table =>
        String(table?.id || '').includes('game-basic') ||
        (Array.isArray(table?.rows) && table.rows.some(row => row?.player !== undefined && (row?.pts !== undefined || row?.mp !== undefined)))
      );
      const selectedTables = basicTables.length ? basicTables : boxTables;
      const box = [];
      for (const table of selectedTables) {
        const tableId = String(table?.id || '');
        const tableTeam = tableId.match(/box-([A-Z]{3})-/i)?.[1]?.toUpperCase() || '';
        for (const row of Array.isArray(table?.rows) ? table.rows : []) {
          const name = String(row?.player || row?.name || '').trim();
          if (!name || /^(team totals|reserves|starters)$/i.test(name)) continue;
          const minutes = row?.mp ?? row?.minutes ?? '';
          const player = {
            name,
            tm: tableTeam || teamAbbrFromUrl(row?.player_url) || String(row?.team_id || ''),
            pts: asNumber(row?.pts),
            reb: asNumber(row?.trb ?? row?.reb),
            ast: asNumber(row?.ast),
            stl: asNumber(row?.stl),
            blk: asNumber(row?.blk),
            min: minutes || '—'
          };
          if (player.min === '—' && !player.pts && !player.reb && !player.ast && !player.stl && !player.blk) continue;
          if (box.some(existing => existing.name === player.name && existing.tm === player.tm)) continue;
          box.push(player);
        }
      }
      if (!box.length) throw new Error('Basketball-Reference returned an incomplete box score for ' + boxId + '.');

      const away = teams[0] || {};
      const home = teams[1] || {};
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
