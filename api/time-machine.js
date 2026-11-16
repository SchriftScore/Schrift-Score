// Historical Schrift Score Time Machine.
// Source: Basketball-Reference regular-season per-game tables.
// For a selected season, the formula is calculated from the 10 preceding seasons.
export const config = { maxDuration: 60 };

const STAT_KEYS = {
  ppg: "pts_per_g",
  rpg: "trb_per_g",
  apg: "ast_per_g",
  spg: "stl_per_g",
  bpg: "blk_per_g",
  gp: "games"
};
const STAT_LABELS = { ppg:"PPG", rpg:"RPG", apg:"APG", spg:"SPG", bpg:"BPG", gp:"GP" };

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
  // Basketball-Reference sometimes wraps stat tables in HTML comments.
  const visibleHtml = String(html).replace(/<!--/g, "").replace(/-->/g, "");
  const match = visibleHtml.match(/<table\b[^>]*id=["']per_game_stats["'][\s\S]*?<\/table>/i);
  if (!match) throw new Error("Basketball-Reference per-game table was not found for " + (year - 1) + "-" + String(year).slice(-2) + ".");
  const tableRows = match[0].match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const rawRows = [];
  for (const tr of tableRows) {
    const cells = {};
    const cellPattern = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
    let cell;
    while ((cell = cellPattern.exec(tr))) {
      const attr = cell[1].match(/data-stat=["']([^"']+)["']/i);
      if (attr) cells[attr[1]] = decodeHtml(cell[2]);
    }
    const name = cells.player;
    if (!name || /^player$/i.test(name)) continue;
    const team = String(cells.team_id || "").trim();
    const gp = numeric(cells.games);
    if (!team || gp <= 0) continue;
    rawRows.push({
      name, team, gp,
      ppg:numeric(cells.pts_per_g), rpg:numeric(cells.trb_per_g),
      apg:numeric(cells.ast_per_g), spg:numeric(cells.stl_per_g),
      bpg:numeric(cells.blk_per_g),
      qualified: /^\d+$/.test(String(cells.ranker || "").trim())
    });
  }
  if (!rawRows.length) throw new Error("Basketball-Reference returned no player rows for season ending " + year + ".");

  // Use Basketball-Reference's combined TOT/2TM line for traded players.
  // If no combined line exists, combine team stints using games played as weights.
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
        ppg:weighted("ppg"), rpg:weighted("rpg"), apg:weighted("apg"),
        spg:weighted("spg"), bpg:weighted("bpg"),
        qualified:rows.some(r => r.qualified)
      };
    }
    players.push(player);
  }
  return players;
}
async function getSeason(year) {
  const url = "https://www.basketball-reference.com/leagues/NBA_" + year + "_per_game.html";
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
      weights[category] = 10 / baseline;
    }

    const targetPlayers = seasons.get(rawYear);
    const rows = targetPlayers.map(player => {
      const ppg = Number(player.ppg.toFixed(1));
      const rpg = Number(player.rpg.toFixed(1));
      const apg = Number(player.apg.toFixed(1));
      const spg = Number(player.spg.toFixed(1));
      const bpg = Number(player.bpg.toFixed(1));
      const gp = player.gp;
      const ssPpg = ppg * weights.ppg;
      const ssRpg = rpg * weights.rpg;
      const ssApg = apg * weights.apg;
      const ssSpg = spg * weights.spg;
      const ssBpg = bpg * weights.bpg;
      const ssGp = gp * weights.gp;
      return {
        name:player.name, team:player.team, gp,
        ppg,rpg,apg,spg,bpg,
        ssPpg,ssRpg,ssApg,ssSpg,ssBpg,ssGp,
        total:ssPpg + ssRpg + ssApg + ssSpg + ssBpg + ssGp
      };
    }).sort((a, b) => b.total - a.total)
      .map((player, index) => ({ ...player, rank:index + 1 }));

    return res.status(200).json({
      source:"Basketball-Reference",
      seasonEndYear:rawYear,
      seasonLabel:(rawYear - 1) + "–" + String(rawYear).slice(-2),
      rollingWindow:{
        startYear:rawYear - 10,
        endYear:rawYear - 1,
        seasons:Array.from({length:10}, (_, i) => rawYear - 10 + i)
      },
      method:"For each of the 10 prior seasons, the top 10 Basketball-Reference qualified players in each category are selected. The 100 values are averaged, then the multiplier is 10 divided by that baseline.",
      qualification:"Basketball-Reference's qualified-player designation on each season's regular-season per-game table.",
      baselines, weights, rows,
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
