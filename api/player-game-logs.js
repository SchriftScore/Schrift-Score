// Vercel serverless endpoint: completed regular-season player-game logs from ESPN.
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  const season = String(req.query?.season || '2026-27');
  if (season !== '2026-27') return res.status(400).json({ error: 'This endpoint currently supports the 2026-27 regular season.' });

  const etDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()).replace(/-/g, '');
  const from = '20261021';
  const to = /^\d{8}$/.test(String(req.query?.to || '')) ? String(req.query.to) : etDate;
  if (to < from) return res.status(200).json({ season, playerGames: [], gameCount: 0, lineCount: 0 });

  const getJson = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'SchriftScore/1.0' } });
    if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
    return response.json();
  };
  const number = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  try {
    const boardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${from}-${to}&limit=500`;
    const board = await getJson(boardUrl);
    const finals = (board.events || []).filter(event => {
      const competition = event.competitions?.[0];
      const type = Number(event.season?.type?.id ?? event.season?.type);
      return competition?.status?.type?.completed && (!Number.isFinite(type) || type === 2);
    });

    const playerGames = [];
    // Small batches avoid overwhelming ESPN and reduce transient box-score failures.
    for (let start = 0; start < finals.length; start += 6) {
      const batch = finals.slice(start, start + 6);
      const summaries = await Promise.all(batch.map(async event => {
        const data = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${event.id}`);
        const competition = event.competitions[0];
        const competitors = competition.competitors || [];
        const home = competitors.find(team => team.homeAway === 'home');
        const away = competitors.find(team => team.homeAway === 'away');
        const gameDate = String(event.date || '').slice(0, 10);
        const rows = [];

        (data.boxscore?.players || []).forEach(teamBlock => {
          const team = teamBlock.team?.abbreviation || '';
          const competitor = competitors.find(item => item.team?.abbreviation === team);
          const isHome = competitor?.homeAway === 'home';
          const opponent = isHome ? away : home;
          const won = competitor?.winner === true ||
            (competitor && home && away && number(competitor.score) > number(opponent?.score));
          (teamBlock.statistics || []).forEach(group => {
            const labels = group.labels || [];
            if (!labels.includes('PTS') || !labels.includes('REB')) return;
            (group.athletes || []).forEach(row => {
              if (!row.athlete) return;
              const stats = row.stats || [];
              const get = key => {
                const index = labels.indexOf(key);
                return index < 0 ? 0 : number(stats[index]);
              };
              const minIndex = labels.indexOf('MIN');
              const minutes = minIndex < 0 ? '' : String(stats[minIndex] || '');
              if (!minutes || minutes === '0' || minutes === '0:00' || minutes === '—') return;
              rows.push({
                name: row.athlete.displayName || row.athlete.shortName || 'Unknown Player',
                team,
                gameDate,
                homeAway: isHome ? 'home' : 'away',
                opp: `${isHome ? 'vs' : '@'} ${opponent?.team?.abbreviation || '—'}`,
                result: won ? 'W' : 'L',
                pts: get('PTS'), reb: get('REB'), ast: get('AST'),
                stl: get('STL'), blk: get('BLK'), minutes
              });
            });
          });
        });
        return rows;
      }));
      summaries.forEach(rows => playerGames.push(...rows));
    }

    if (finals.length && !playerGames.length) {
      return res.status(502).json({ error: 'ESPN returned completed games but no usable player box-score lines.' });
    }
    playerGames.sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.name.localeCompare(b.name));
    return res.status(200).json({
      season, from, to, gameCount: finals.length,
      lineCount: playerGames.length, playerGames
    });
  } catch (error) {
    console.error('Schrift Score player-game log error:', error);
    return res.status(502).json({ error: 'The ESPN completed box-score feed is temporarily unavailable. Please retry shortly.' });
  }
}
