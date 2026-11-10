// Vercel serverless function: fetches yesterday's NBA scoreboard and player box scores server-side.
// This avoids browser CORS restrictions and unreliable third-party CORS proxies.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const date = String(req.query?.date || '');
  if (!/^\\d{8}$/.test(date)) return res.status(400).json({ error: 'Use date=YYYYMMDD.' });

  const getJson = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'SchriftScore/1.0' } });
    if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
    return response.json();
  };
  const score = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  try {
    const boardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}&limit=100`;
    const board = await getJson(boardUrl);
    const finals = (board.events || []).filter(e => e.competitions?.[0]?.status?.type?.completed);
    const games = await Promise.all(finals.map(async event => {
      const comp = event.competitions[0];
      const teams = comp.competitors || [];
      const away = teams.find(t => t.homeAway === 'away') || teams[0];
      const home = teams.find(t => t.homeAway === 'home') || teams[1];
      const data = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${event.id}`);
      const players = [];
      (data.boxscore?.players || []).forEach(teamBlock => {
        const teamAbbr = teamBlock.team?.abbreviation || '';
        (teamBlock.statistics || []).forEach(statGroup => {
          const labels = statGroup.labels || [];
          (statGroup.athletes || []).forEach(row => {
            const vals = row.stats || [];
            const val = key => {
              const i = labels.indexOf(key);
              return i >= 0 ? score(vals[i]) : 0;
            };
            if (!row.athlete) return;
            const p = {
              name: row.athlete.displayName || row.athlete.shortName || 'Player',
              tm: teamAbbr,
              pts: val('PTS'), reb: val('REB'), ast: val('AST'), stl: val('STL'), blk: val('BLK'),
              min: vals[labels.indexOf('MIN')] || '—'
            };
            if (p.pts || p.reb || p.ast || p.stl || p.blk || p.min !== '—') players.push(p);
          });
        });
      });
      return {
        awayTeam: away?.team?.abbreviation || '—', awayScore: score(away?.score),
        homeTeam: home?.team?.abbreviation || '—', homeScore: score(home?.score),
        eventId: event.id, dateKey: date, box: players
      };
    }));
    if (!games.length) return res.status(404).json({ error: 'No completed NBA games were returned for this date.' });
    if (games.some(g => !g.box.length)) return res.status(502).json({ error: 'At least one box score was incomplete; refusing to show partial or misleading results.' });
    return res.status(200).json({ date, games });
  } catch (error) {
    console.error('SchriftScore NBA API error:', error);
    return res.status(502).json({ error: 'The upstream NBA scoreboard or box-score feed is temporarily unavailable.' });
  }
}
