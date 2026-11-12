// Vercel serverless endpoint for real game-level Schrift Score analytics.
// Pulls completed NBA games from ESPN scoreboard + official box-score summaries.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const windowKey = String(req.query?.window || 'season');
  if (!['season', '7', '14', '30'].includes(windowKey)) {
    return res.status(400).json({ error: 'Use window=season, 7, 14, or 30.' });
  }

  const now = new Date();
  const etDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const end = new Date(etDate + 'T12:00:00-05:00');
  const start = new Date(end);
  if (windowKey === 'season') start.setFullYear(2026, 9, 21);
  else start.setDate(start.getDate() - (Number(windowKey) - 1));
  const dateKey = d => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d).replaceAll('-', '');
  const startKey = dateKey(start);
  const endKey = dateKey(end);
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const getJson = async url => {
    const response = await fetch(url, { headers: { 'User-Agent': 'SchriftScore/1.0' } });
    if (!response.ok) throw new Error('ESPN returned HTTP ' + response.status);
    return response.json();
  };

  try {
    // ESPN's NBA scoreboard is reliable by month; fetch month buckets and
    // filter the requested rolling window locally (date-range queries can 400).
    const monthKeys = new Set();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) monthKeys.add(dateKey(d).slice(0, 6));
    const monthBoards = await Promise.all([...monthKeys].map(month =>
      getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + month + '&seasontype=2&limit=500')
    ));
    const eventMap = new Map();
    monthBoards.forEach(payload => (payload.events || []).forEach(event => {
      const eventDate = event.date ? new Date(event.date) : null;
      const eventDay = eventDate ? dateKey(eventDate) : '';
      if (eventDay >= startKey && eventDay <= endKey) eventMap.set(event.id, event);
    }));
    const finals = [...eventMap.values()].filter(e => e.competitions?.[0]?.status?.type?.completed);
    const games = [];
    const workers = Array.from({ length: Math.min(10, finals.length) }, async (_, workerIndex) => {
      for (let i = workerIndex; i < finals.length; i += Math.min(10, finals.length)) {
        const event = finals[i];
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const competitors = comp.competitors || [];
        const away = competitors.find(t => t.homeAway === 'away');
        const home = competitors.find(t => t.homeAway === 'home');
        const summary = await getJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=' + event.id);
        const date = event.date || comp.date;
        const dateOnly = date ? dateKey(new Date(date)).replace(/^(\\d{4})(\\d{2})(\\d{2})$/, '$1-$2-$3') : '';
        for (const teamBlock of summary.boxscore?.players || []) {
          const team = teamBlock.team?.abbreviation || '';
          const teamComp = competitors.find(t => t.team?.abbreviation === team);
          const opponent = competitors.find(t => t.team?.abbreviation !== team);
          for (const group of teamBlock.statistics || []) {
            const labels = group.labels || [];
            for (const row of group.athletes || []) {
              if (!row.athlete) continue;
              const vals = row.stats || [];
              const get = key => {
                const idx = labels.indexOf(key);
                return idx < 0 ? 0 : vals[idx];
              };
              const pts = num(get('PTS'));
              const reb = num(get('REB'));
              const ast = num(get('AST'));
              const stl = num(get('STL'));
              const blk = num(get('BLK'));
              const minRaw = get('MIN');
              const played = (minRaw !== undefined && minRaw !== null && String(minRaw) !== '' && String(minRaw) !== '0:00') || pts + reb + ast + stl + blk > 0;
              if (!played) continue;
              const playerName = row.athlete.displayName || row.athlete.shortName;
              if (!playerName) continue;
              const weights = { ppg: 0.35, rpg: 0.83, apg: 1.14, spg: 1.80, bpg: 1.98, gp: 0.04 };
              const ss = pts * weights.ppg + reb * weights.rpg + ast * weights.apg + stl * weights.spg + blk * weights.bpg + weights.gp;
              games.push({
                name: playerName, team, date: dateOnly, eventId: event.id,
                opponent: opponent?.team?.abbreviation || '—',
                homeAway: teamComp?.homeAway || '—',
                result: teamComp && opponent ? (num(teamComp.score) > num(opponent.score) ? 'W' : 'L') : '—',
                pts, reb, ast, stl, blk, minutes: minRaw || '—', ss
              });
            }
          }
        }
      }
    });
    await Promise.all(workers);
    games.sort((a, b) => b.date.localeCompare(a.date));
    return res.status(200).json({
      window: windowKey, startDate: startKey, endDate: endKey,
      games, gameCount: finals.length, generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Schrift Score analytics feed failed:', error);
    return res.status(502).json({ error: 'Real game-level NBA data is temporarily unavailable. No estimated stats were substituted.' });
  }
}
