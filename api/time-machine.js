// Historical Schrift Score Time Machine.
// Source: Basketball-Reference regular-season totals tables. SportsLogos.Net provides season-specific team logo assets when available.
// For a selected season, the formula is calculated from the 10 preceding seasons.
export const config = { maxDuration: 60 };

// Parsed player rows use normalized property names; baseline ranking must use these keys.
const STAT_KEYS = { pts: "pts", trb: "trb", ast: "ast", stl: "stl", blk: "blk" };
const STAT_LABELS = { pts:"PTS", trb:"TRB", ast:"AST", stl:"STL", blk:"BLK" };

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function numeric(value) {
  if (value === null || value === undefined || value === "" || value === "—" || value === "-") return 0;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function parseSeasonTable(html, year) {
  const source = String(html || "");
  const visibleHtml = source.replace(/<!--/g, "").replace(/-->/g, "");
  const match = visibleHtml.match(/<table\b[^>]*id\s*=\s*["']totals_stats["'][\s\S]*?<\/table>/i);
  if (!match) {
    const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,""])[1].replace(/<[^>]*>/g, " ").trim();
    throw new Error("Basketball-Reference totals table was not found for season ending " + year + (title ? " (page title: " + title.slice(0, 100) + ")" : "") + ".");
  }

  const tableRows = match[0].match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const rawRows = [];
  let rowsWithPlayer = 0;
  let rowsWithGp = 0;
  let rowsWithStats = 0;
  const sampleCells = [];
  for (const tr of tableRows) {
    const cells = {};
    const cellPattern = /<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi;
    let cell;
    while ((cell = cellPattern.exec(tr))) {
      const attr = cell[1].match(/data-stat\s*=\s*["']([^"']+)["']/i);
      if (attr) cells[attr[1]] = decodeHtml(cell[2]);
    }
    if (Object.keys(cells).length && sampleCells.length < 3) sampleCells.push(Object.keys(cells).join(","));
    const name = cells.player || cells.name_display || cells.player_name;
    if (!name || /^player$/i.test(name)) continue;
    rowsWithPlayer++;
    const gp = numeric(cells.games ?? cells.g ?? cells.gp);
    if (gp > 0) rowsWithGp++;
    const hasStats = ["pts","trb","ast","stl","blk"].some(k => cells[k] !== undefined);
    if (hasStats) rowsWithStats++;
    if (gp <= 0) continue;
    const team = String(cells.team_name_abbr || cells.team_id || cells.team || cells.team_name || "UNK").trim();
    rawRows.push({
      name, team, gp,
      pts:numeric(cells.pts), trb:numeric(cells.trb),
      ast:numeric(cells.ast), stl:numeric(cells.stl),
      blk:numeric(cells.blk),
      qualified:false
    });
  }
  if (!rawRows.length) {
    throw new Error("No usable player rows for season ending " + year + " (table rows: " + tableRows.length + ", player cells: " + rowsWithPlayer + ", rows with GP: " + rowsWithGp + ", rows with stat cells: " + rowsWithStats + ", sample data-stat keys: " + (sampleCells.join(" | ") || "none") + ").");
  }

  const teamGames = new Map();
  for (const row of rawRows) {
    if (/^(TOT|\d+TM)$/.test(row.team)) continue;
    teamGames.set(row.team, Math.max(teamGames.get(row.team) || 0, row.gp));
  }

  const grouped = new Map();
  for (const row of rawRows) {
    const key = normalizeName(row.name);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const players = [];
  for (const rows of grouped.values()) {
    const combined = rows.find(r => /^(TOT|\d+TM)$/.test(r.team));
    let player;
    if (combined) {
      player = { ...combined };
    } else if (rows.length === 1) {
      player = { ...rows[0] };
    } else {
      const gp = rows.reduce((sum, r) => sum + r.gp, 0);
      const weighted = key => rows.reduce((sum, r) => sum + r[key] * r.gp, 0) / gp;
      player = {
        ...rows[rows.length - 1], gp,
        pts:weighted("pts"), trb:weighted("trb"), ast:weighted("ast"),
        stl:weighted("stl"), blk:weighted("blk"),
        qualified:rows.some(r => r.qualified)
      };
    }
    const teamStints = rows.filter(r => !/^(TOT|\d+TM)$/.test(r.team));
    const relevantTeams = teamStints.length ? teamStints : [player];
    const teamGamesPlayed = Math.max(...relevantTeams.map(r => teamGames.get(r.team) || r.gp));
    player.qualified = player.gp >= Math.ceil(teamGamesPlayed * 0.70);
    players.push(player);
  }
  return players;
}
async function getSeason(year) {
  const url = "https://www.basketball-reference.com/leagues/NBA_" + year + "_totals.html";
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SchriftScore/1.0; +https://nbaschriftscore.com)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("Basketball-Reference returned HTTP " + response.status + " for season ending " + year + ".");
  const html = await response.text();
  return parseSeasonTable(html, year);
}

const TEAM_NAMES = {
  ATL:"Atlanta Hawks", BOS:"Boston Celtics", BRK:"Brooklyn Nets", BKN:"Brooklyn Nets", NJN:"New Jersey Nets",
  CHA:"Charlotte Hornets", CHH:"Charlotte Hornets", CHO:"Charlotte Hornets", CHI:"Chicago Bulls", CLE:"Cleveland Cavaliers",
  DAL:"Dallas Mavericks", DEN:"Denver Nuggets", DET:"Detroit Pistons", GSW:"Golden State Warriors", HOU:"Houston Rockets",
  IND:"Indiana Pacers", LAC:"Los Angeles Clippers", LAL:"Los Angeles Lakers", MEM:"Memphis Grizzlies", VAN:"Vancouver Grizzlies",
  MIA:"Miami Heat", MIL:"Milwaukee Bucks", MIN:"Minnesota Timberwolves", NOH:"New Orleans Hornets", NOK:"New Orleans/Oklahoma City Hornets",
  NOP:"New Orleans Pelicans", NYK:"New York Knicks", OKC:"Oklahoma City Thunder", ORL:"Orlando Magic", PHI:"Philadelphia 76ers",
  PHX:"Phoenix Suns", POR:"Portland Trail Blazers", SAC:"Sacramento Kings", SAS:"San Antonio Spurs", SEA:"Seattle SuperSonics",
  TOR:"Toronto Raptors", UTA:"Utah Jazz", WAS:"Washington Wizards", WSB:"Washington Bullets"
};
async function getSportsLogosForSeason(year) {
  try {
    const url = "https://www.sportslogos.net/teams/list_by_year/62" + year + "/" + year + "-NBA-Logos-By-Year/";
    const response = await fetch(url, {
      headers: { "User-Agent":"Mozilla/5.0 (compatible; SchriftScore/1.0; +https://nbaschriftscore.com)", "Accept":"text/html" },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return {};
    const html = await response.text();
    const logos = {};
    const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
    for (const anchor of anchors) {
      const image = anchor.match(/<(?:img|source)\b[^>]*(?:src|data-src)=["'](https?:\/\/content\.sportslogos\.net\/[^"']+)["'][^>]*>/i);
      if (!image) continue;
      const alt = (anchor.match(/alt=["']([^"']+)["']/i) || [,""])[1];
      const href = (anchor.match(/href=["']([^"']+)["']/i) || [,""])[1];
      const label = decodeHtml(alt || href || anchor.replace(/<[^>]*>/g," ")).toLowerCase().replace(/[^a-z0-9]/g,"");
      for (const [abbr, name] of Object.entries(TEAM_NAMES)) {
        const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g,"");
        if (label.includes(normalizedName)) logos[abbr] = image[1];
      }
    }
    return logos;
  } catch (_) {
    return {};
  }
}
async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  const rawYear = Number(req.query?.season || 2016);
  if (!Number.isInteger(rawYear) || rawYear < 1984 || rawYear > 2027) {
    return res.status(400).json({ error: "Choose a season from 1983–84 through 2026–27." });
  }

  try {
    const seasons = new Map();
    // Keep requests sequential to respect Basketball-Reference's published scraping limits.
    for (let year = rawYear - 10; year <= rawYear; year++) {
      seasons.set(year, await getSeason(year));
      if (year < rawYear) await wait(3000);
    }

    const historicalSeasons = [];
    for (let year = rawYear - 10; year < rawYear; year++) {
      const players = seasons.get(year);
      const qualified = players.filter(p => p.qualified);
      if (!qualified.length) {
        throw new Error("Basketball-Reference did not mark qualified players for season ending " + year + ".");
      }
      historicalSeasons.push({ year, players:qualified });
    }

    const baselines = {};
    const weights = {};
    for (const [category, field] of Object.entries(STAT_KEYS)) {
      const topValues = [];
      for (const season of historicalSeasons) {
        const topTen = [...season.players]
          .sort((a, b) => b[field] - a[field])
          .slice(0, 10);
        if (topTen.length !== 10) throw new Error("Not enough qualified players for " + category + " in season ending " + season.year + ".");
        topValues.push(...topTen.map(p => p[field]));
      }
      const aggregate = topValues.reduce((sum, value) => sum + value, 0);
      const baseline = aggregate / 100;
      if (!(baseline > 0)) throw new Error("Could not calculate a valid " + category + " baseline.");
      baselines[category] = baseline;
      weights[category] = ["stl", "blk"].includes(category) ? baseline : 10 / baseline;
    }

    const teamLogos = await getSportsLogosForSeason(rawYear);\n\n    const targetPlayers = seasons.get(rawYear);
    const rows = targetPlayers.map(player => {
      const pts = player.pts, trb = player.trb, ast = player.ast, stl = player.stl, blk = player.blk;
      const gp = player.gp;
      const ssPts = pts * weights.pts;
      const ssTrb = trb * weights.trb;
      const ssAst = ast * weights.ast;
      const ssStl = stl * weights.stl;
      const ssBlk = blk * weights.blk;
      const ssGp = gp * 0.04;
      return {
        name:player.name, team:player.team, gp,
        pts,trb,ast,stl,blk,
        ssPts,ssTrb,ssAst,ssStl,ssBlk,ssGp,
        total:ssPts + ssTrb + ssAst + ssStl + ssBlk + ssGp
      };
    }).sort((a, b) => b.total - a.total)
      .map((player, index) => ({ ...player, rank:index + 1 }));

    return res.status(200).json({
      source:"Basketball-Reference totals",
      seasonEndYear:rawYear,
      seasonLabel:(rawYear - 1) + "–" + String(rawYear).slice(-2),
      rollingWindow:{
        startYear:rawYear - 10,
        endYear:rawYear - 1,
        seasons:Array.from({length:10}, (_, i) => rawYear - 10 + i)
      },
      method:"For PTS, TRB, and AST, the top 10 qualified players by season total from each of the 10 prior seasons are averaged (100 values per category), then the weight is 10 divided by that baseline. For STL and BLK, the same 100-value average is used directly as the weight. Games played uses a fixed 0.04 coefficient.",
      qualification:"At least 70% of team games. Team schedules are estimated from the highest games-played total among players on that team; rows without a team value use the league-high GP estimate.",
      baselines, weights, rows, teamLogos,
      playerCount:rows.length,
      qualifiedCounts:Object.fromEntries(historicalSeasons.map(s => [s.year, s.players.length])),
      generatedAt:new Date().toISOString()
    });
  } catch (error) {
    console.error("Schrift Score Time Machine failed:", error);
    return res.status(502).json({
      error:"Historical data could not be loaded from Basketball-Reference: " + (error?.message || "Unknown error")
    });
  }
}
