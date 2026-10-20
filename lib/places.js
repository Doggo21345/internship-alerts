// Where a posting is. Copied from linkedin-sourcer lib/boards.js (countriesIn),
// so the scanner can tag each job with its countries once and every sheet
// just compares codes.

// Country names and the ISO codes postings use ("Dublin, IE", "GB-London").
const COUNTRY_NAMES = [
  ["US", /\b(?:united states(?: of america)?|u\.s\.a?\.?|usa)\b/i], ["CA", /\bcanada\b/i],
  ["GB", /\b(?:united kingdom|england|scotland|wales|great britain)\b/i], ["IE", /\bireland\b/i],
  ["DE", /\bgermany\b/i], ["FR", /\bfrance\b/i], ["NL", /\b(?:netherlands|holland)\b/i],
  ["CH", /\bswitzerland\b/i], ["IN", /\bindia\b/i], ["SG", /\bsingapore\b/i], ["JP", /\bjapan\b/i],
  ["AU", /\baustralia\b/i], ["HK", /\bhong kong\b/i], ["MX", /\bmexico\b/i], ["PL", /\bpoland\b/i],
  ["ES", /\bspain\b/i], ["RS", /\bserbia\b/i], ["RO", /\bromania\b/i], ["DK", /\bdenmark\b/i],
  ["QA", /\bqatar\b/i], ["KR", /\b(?:south korea|korea)\b/i], ["CN", /\bchina\b/i], ["BR", /\bbrazil\b/i],
  ["IL", /\bisrael\b/i], ["SE", /\bsweden\b/i], ["IT", /\bitaly\b/i], ["PT", /\bportugal\b/i],
  ["BE", /\bbelgium\b/i], ["AT", /\baustria\b/i], ["TW", /\btaiwan\b/i], ["NZ", /\bnew zealand\b/i],
  ["AE", /\b(?:united arab emirates|uae)\b/i]
];
const ISO = new Set(["US", "GB", "UK", "IE", "DE", "FR", "NL", "CH", "IN", "SG", "JP", "AU", "HK", "MX", "PL", "ES",
  "RS", "RO", "DK", "QA", "KR", "CN", "BR", "IL", "SE", "IT", "PT", "BE", "AT", "TW", "NZ", "AE"]);

const US_STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const US_STATE_NAMES = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming|d\.c\.)\b/i;
const CA_PROVINCES = /\b(?:ON|BC|QC|AB|MB|NS|NB|NL|PE|SK)\b|\b(?:ontario|quebec|british columbia|alberta|manitoba|nova scotia)\b/i;

// Cities that often appear on their own ("Toronto", "Bangalore", "London").
const CITIES = [
  ["US", /\b(?:new york(?: city)?|nyc|san francisco|seattle|boston|chicago|austin|los angeles|bay area|silicon valley|pittsburgh|mountain view|palo alto|menlo park|sunnyvale|san jose|san mateo|atlanta|denver|dallas|miami|philadelphia|bellevue|redmond|cambridge, ma)\b/i],
  ["CA", /\b(?:toronto|montreal|montr[eé]al|vancouver|waterloo|ottawa|calgary|longueuil)\b/i],
  ["GB", /\b(?:london|manchester|edinburgh|cambridge, uk)\b/i], ["FR", /\bparis\b/i],
  ["DE", /\b(?:berlin|munich|m[uü]nchen|hamburg)\b/i], ["NL", /\bamsterdam\b/i], ["IE", /\bdublin\b/i],
  ["CH", /\b(?:zurich|z[uü]rich|geneva)\b/i],
  ["IN", /\b(?:bangalore|bengaluru|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|chennai|noida)\b/i],
  ["JP", /\btokyo\b/i], ["AU", /\b(?:sydney|melbourne)\b/i], ["ES", /\b(?:madrid|barcelona)\b/i],
  ["PL", /\b(?:warsaw|krakow|krak[oó]w)\b/i], ["RS", /\b(?:belgrade|novi sad)\b/i], ["RO", /\bbucharest\b/i],
  ["DK", /\b(?:copenhagen|aarhus)\b/i], ["QA", /\bdoha\b/i], ["KR", /\bseoul\b/i],
  ["IL", /\btel aviv\b/i], ["SE", /\bstockholm\b/i], ["CN", /\b(?:shanghai|beijing|shenzhen)\b/i],
  ["BR", /\bs[aã]o paulo\b/i], ["MX", /\bmexico city\b/i]
];

/**
 * The countries a location string names, as a Set of codes. Empty when it
 * doesn't say ("Remote", "Hybrid", "In-Office"). Handles one location or several
 * joined with ; • | , and the trap that "CA" is Canada in "Toronto, ON, CA" but
 * California in "Menlo Park, CA".
 */
export function countriesIn(location) {
  const found = new Set();
  for (const raw of String(location || "").split(/[;•|]|\s+or\s+/i)) {
    const seg = raw.trim();
    if (!seg) continue;
    const canadian = CA_PROVINCES.test(seg) || /\bcanada\b/i.test(seg);
    for (const [code, re] of COUNTRY_NAMES) if (re.test(seg)) found.add(code);
    // A leading code is always a country ("DE-Berlin" is Germany, not Delaware).
    const prefix = seg.match(/^(?:[\w ]+-)?([A-Z]{2})-[A-Z]/);
    if (prefix && ISO.has(prefix[1])) found.add(prefix[1] === "UK" ? "GB" : prefix[1]);
    // Comma-separated codes: "Dublin, IE", "Menlo Park, CA", "Toronto, ON, CA".
    let pinned = canadian; // a state or province means one specific place
    for (const raw of seg.split(/\s*,\s*/)) {
      const tok = raw.trim().replace(/\./g, "");
      if (tok === "CA") { found.add(canadian ? "CA" : "US"); pinned = true; }
      else if (tok === "UK") found.add("GB");
      else if (US_STATES.includes(tok)) { found.add("US"); pinned = true; }
      else if (ISO.has(tok)) found.add(tok);
    }
    if (canadian) found.add("CA");
    if (US_STATE_NAMES.test(seg)) { found.add("US"); pinned = true; }
    // Cities count unless a state or province already pins the place, so
    // "London, Paris, Tokyo" finds all three but "Dublin, CA" stays in the US
    // and "London, ON" stays in Canada.
    if (!pinned) for (const [code, re] of CITIES) if (re.test(seg)) found.add(code);
  }
  return found;
}

