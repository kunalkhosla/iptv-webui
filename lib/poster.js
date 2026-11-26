// Tile poster URL (pure). Order:
//  1. the TMDB poster of the title's matched TMDB entry;
//  2. a panel icon that is itself a TMDB image (re-sized to the tile size);
//  3. any other https panel icon (never http: browsers block it on an https
//     page as mixed content, and never a data: URI);
//  4. null — the client draws a generated title card (never initials).
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
const TMDB_ICON_RE = /^https?:\/\/(?:image\.tmdb\.org|(?:www\.)?themoviedb\.org)\/t\/p\/[a-z0-9_]+\/([A-Za-z0-9_-]{8,64}\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i;

function tmdbPathFromIcon(icon) {
  if (typeof icon !== "string") return null;
  const m = TMDB_ICON_RE.exec(icon.trim());
  return m ? `/${m[1]}` : null;
}

function posterUrl(t, icon, size = "w342") {
  if (t && typeof t.poster_path === "string" && t.poster_path.startsWith("/")) return `${TMDB_IMG_BASE}/${size}${t.poster_path}`;
  const p = tmdbPathFromIcon(icon);
  if (p) return `${TMDB_IMG_BASE}/${size}${p}`;
  if (typeof icon === "string" && /^https:\/\/[^\s"'<>]+$/i.test(icon.trim()) && icon.length <= 1000) return icon.trim();
  return null;
}

module.exports = { posterUrl, tmdbPathFromIcon };
