// Basketball-Reference is the sole source of truth for the 2026-27 leaderboard.
// API.SH retrieves Basketball-Reference's public page as structured JSON.
// The API key is server-side only (Vercel environment variable: APISH_API_KEY).
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');

  const season = String(req.query?.season || '2027');
  if (season !== '2027') {
    return res.status(400).json({ error: 'Only the 2026-27 season is currently supported.' });
  }

  const apiKey = process.env.APISH_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Basketball-Reference data is not configured. Add APISH_API_KEY to the Vercel Production environment and redeploy.' });
  }

  const number = value => {
    if (value === null || value === undefined || value === '' || value === '-') return 0;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const findTable = payload => {
    const tables = payload?.tables;
    if (Array.isArray(tables)) return tables.find(table => table?.id === 'per_game_stats') || tables[0];
    if (tables && typeof tables === 'object') {
      return tables.per_game_stats || Object.values(tables).find(table => table?.id === 'per_game_stats') || Object.values(tables)[0];
    }
    return null;
  };

  try {
    const url = new URL('https://api.api.sh/basketball-reference/v1/player-stats');
    url.searchParams.set('season', season);
    url.searchParams.set('type', 'per_game');
    url.searchParams.set('league', 'nba');
    url.searchParams.set('tables', 'per_game_stats');
    url.searchParams.set('fresh', '1');

    const response = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamMessage = payload?.error || payload?.message || ('API.SH returned HTTP ' + response.status);
      throw new Error(upstreamMessage);
    }

    const table = findTable(payload);
    if (!table || !Array.isArray(table.rows)) {
      throw new Error('API.SH did not return the Basketball-Reference per_game_stats table.');
    }

    const rawRows = table.rows;
    const parsedRows = rawRows.map(row => {
      const get = (...keys) => {
        for (const key of keys) {
          if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
        }
        return '';
      };
      const name = String(get('player', 'name')).trim();
      const team = String(get('team_id', 'team', 'tm')).trim();
      return {
        name,
        playerId: String(get('player_id', 'id')).trim(),
        team,
        gp: number(get('g', 'games', 'gp')),
        ppg: number(get('pts_per_g', 'pts', 'ppg')),
        rpg: number(get('trb_per_g', 'reb_per_g', 'trb', 'rpg')),
        apg: number(get('ast_per_g', 'ast', 'apg')),
        spg: number(get('stl_per_g', 'stl', 'spg')),
        bpg: number(get('blk_per_g', 'blk', 'bpg'))
      };
    }).filter(player => player.name && player.gp > 0);

    if (!parsedRows.length) {
      throw new Error('Basketball-Reference returned no usable player rows. The API response format may have changed.');
    }

    // Basketball-Reference includes team stints plus a TOT row for traded players.
    // Prefer the TOT row so every player appears once; otherwise keep the player's only team row.
    const byPlayer = new Map();
    for (const player of parsedRows) {
      const key = player.playerId || player.name.toLowerCase();
      const existing = byPlayer.get(key);
      if (!existing || player.team === 'TOT' || (existing.team !== 'TOT' && player.gp > existing.gp)) {
        byPlayer.set(key, player);
      }
    }

    const weights = { ppg: 0.35, rpg: 0.83, apg: 1.14, spg: 1.80, bpg: 1.98, gp: 0.04 };
    const players = [...byPlayer.values()]
      .map(player => ({
        ...player,
        rankYesterday: null,
        rankChange: null,
        ssPpg: player.ppg * weights.ppg,
        ssRpg: player.rpg * weights.rpg,
        ssApg: player.apg * weights.apg,
        ssSpg: player.spg * weights.spg,
        ssBpg: player.bpg * weights.bpg,
        ssGp: player.gp * weights.gp,
        total: player.ppg * weights.ppg + player.rpg * weights.rpg +
          player.apg * weights.apg + player.spg * weights.spg +
          player.bpg * weights.bpg + player.gp * weights.gp
      }))
      .sort((a, b) => b.total - a.total)
      .map((player, index) => ({ ...player, rank: index + 1 }));

    return res.status(200).json({
      source: 'Basketball-Reference',
      retrieval: 'API.SH',
      sourceUrl: 'https://www.basketball-reference.com/leagues/NBA_2027_per_game.html',
      season: '2026-27',
      updatedAt: payload.fetched_at || new Date().toISOString(),
      creditsUsed: payload.credits_used ?? null,
      count: players.length,
      players
    });
  } catch (error) {
    console.error('Basketball-Reference leaderboard fetch failed:', error);
    return res.status(502).json({
      error: 'Basketball-Reference stats could not be retrieved through API.SH. No spreadsheet, ESPN, or stale fallback data was substituted.'
    });
  }
}
