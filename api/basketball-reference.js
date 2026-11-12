// Basketball-Reference is the source of truth for the 2026-27 season leaderboard.
// Reads the official per-game table and fails closed rather than substituting another provider.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  const season = String(req.query?.season || '2027');
  if (season !== '2027') return res.status(400).json({ error: 'Only the 2026-27 season is currently supported.' });

  const decode = value => String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    const url = 'https://www.basketball-reference.com/leagues/NBA_2027_per_game.html';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SchriftScore/1.0; +https://nbaschriftscore.com)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) throw new Error('Basketball-Reference returned HTTP ' + response.status);
    let html = await response.text();
    // Basketball-Reference sometimes wraps table markup in HTML comments.
    html = html.replace(/<!--[\s\S]*?-->/g, block => block.slice(4, -3));
    const tableMatch = html.match(/<table[^>]*id=["']per_game_stats["'][\s\S]*?<\/table>/i);
    if (!tableMatch) throw new Error('Could not locate Basketball-Reference per-game table.');

    const rows = [];
    const trMatches = tableMatch[0].match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells = {};
      const cellMatches = tr.match(/<(?:th|td)\b[^>]*data-stat=["'][^"']+["'][^>]*>[\s\S]*?<\/(?:th|td)>/gi) || [];
      for (const cell of cellMatches) {
        const stat = cell.match(/data-stat=["']([^"']+)["']/i)?.[1];
        if (stat) cells[stat] = decode(cell.replace(/^<(?:th|td)\b[^>]*>/i, '').replace(/<\/(?:th|td)>$/i, ''));
      }
      const name = cells.player;
      if (!name || !cells.g || !cells.pts_per_g) continue;
      const number = key => {
        const value = Number(cells[key]);
        return Number.isFinite(value) ? value : 0;
      };
      const player = {
        name,
        team: cells.team_id || 'NBA',
        gp: number('g'),
        ppg: number('pts_per_g'),
        rpg: number('trb_per_g'),
        apg: number('ast_per_g'),
        spg: number('stl_per_g'),
        bpg: number('blk_per_g')
      };
      if (player.gp > 0) rows.push(player);
    }

    if (!rows.length) throw new Error('Basketball-Reference returned no usable player rows.');
    const weights = { ppg: 0.35, rpg: 0.83, apg: 1.14, spg: 1.80, bpg: 1.98, gp: 0.04 };
    const players = rows
      .map(p => ({
        ...p,
        rankYesterday: null,
        rankChange: 0,
        ssPpg: p.ppg * weights.ppg,
        ssRpg: p.rpg * weights.rpg,
        ssApg: p.apg * weights.apg,
        ssSpg: p.spg * weights.spg,
        ssBpg: p.bpg * weights.bpg,
        ssGp: p.gp * weights.gp,
        total: p.ppg * weights.ppg + p.rpg * weights.rpg + p.apg * weights.apg +
          p.spg * weights.spg + p.bpg * weights.bpg + p.gp * weights.gp
      }))
      .sort((a, b) => b.total - a.total)
      .map((p, i) => ({ ...p, rank: i + 1 }));

    return res.status(200).json({
      source: 'Basketball-Reference',
      sourceUrl: url,
      season: '2026-27',
      updatedAt: new Date().toISOString(),
      count: players.length,
      players
    });
  } catch (error) {
    console.error('Basketball-Reference leaderboard fetch failed:', error);
    return res.status(502).json({
      error: 'Basketball-Reference stats could not be retrieved. No other data source or stale fallback was substituted.'
    });
  }
}
