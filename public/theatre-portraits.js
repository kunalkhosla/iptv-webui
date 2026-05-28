// Theatre Portraits — hand-illustrated SVG avatars for the
// Marquee profile picker. Nine characters in the vintage
// marquee palette, each as a self-contained <svg viewBox=
// "0 0 100 100"> string that CSS sizes. No external assets,
// no font dependencies beyond Bebas Neue (only the Ringmaster
// uses inline <text>).
//
// Profile data stores `avatar: "magician"` (one of the ids
// below). When a profile has no avatar (old data, new install)
// we deterministically pick one from the nick — same nick
// always maps to the same character.
//
// To add a new portrait: drop another entry in PORTRAITS below
// in the order it should appear in the picker grid. The picker
// auto-fills from this list — no other client/server change.

(function (global) {
  // Style notes baked into every portrait:
  //   - 100×100 viewBox, head-and-shoulders composition centered ~y=44
  //   - Per-portrait radial gradient backdrop, palette pulled from
  //     the Marquee theme (orange #f08245, brass #d4a544, crimson
  //     #c43c3c, etc.) so a row of mixed avatars stays cohesive
  //   - Skin tone #f0d2ad for human characters; black-cat / animal
  //     subjects swap in a darker silhouette
  //   - Outlines are filled shapes, not stroked, so the silhouette
  //     reads cleanly at small sizes (down to 26px in the header chip)

  const PORTRAITS = {
    chanteuse: {
      label: "The Chanteuse",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="38%" r="70%"><stop offset="0%" stop-color="#a3424c"/><stop offset="100%" stop-color="#3a1820"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<path d="M 38,0 L 62,0 L 78,100 L 22,100 Z" fill="#f6d28a" opacity="0.08"/>
<path d="M 14,100 Q 26,80 38,76 L 62,76 Q 74,80 86,100 Z" fill="#1a1e3a"/>
<path d="M 36,76 L 39,86" stroke="#d4a544" stroke-width="1.6" stroke-linecap="round"/>
<path d="M 64,76 L 61,86" stroke="#d4a544" stroke-width="1.6" stroke-linecap="round"/>
<rect x="44" y="60" width="12" height="20" fill="#e8c8a3"/>
<ellipse cx="50" cy="44" rx="18" ry="22" fill="#f0d2ad"/>
<path d="M 30,42 Q 28,18 50,16 Q 72,18 70,42 Q 70,52 64,58 Q 62,48 60,44 Q 58,52 56,56 Q 54,46 50,42 Q 46,46 44,56 Q 42,52 40,44 Q 38,48 36,58 Q 30,52 30,42 Z" fill="#1a1320"/>
<path d="M 40,42 Q 43,44 46,42" stroke="#1a1320" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M 54,42 Q 57,44 60,42" stroke="#1a1320" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M 46,52 Q 50,57 54,52 Q 53,55 50,55 Q 47,55 46,52 Z" fill="#d63a3a"/>
<line x1="50" y1="76" x2="50" y2="95" stroke="#3a3f5a" stroke-width="2.2"/>
<ellipse cx="50" cy="74" rx="6" ry="7" fill="#262c4d" stroke="#d4a544" stroke-width="0.8"/>
<line x1="46" y1="71" x2="54" y2="71" stroke="#d4a544" stroke-width="0.5"/>
<line x1="46" y1="74" x2="54" y2="74" stroke="#d4a544" stroke-width="0.5"/>
<line x1="46" y1="77" x2="54" y2="77" stroke="#d4a544" stroke-width="0.5"/>
</svg>`,
    },

    magician: {
      label: "The Magician",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="40%" r="72%"><stop offset="0%" stop-color="#6e3f5f"/><stop offset="100%" stop-color="#221428"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<g fill="#f6d28a" opacity="0.7">
<path d="M 14 24 l 1 -3 l 1 3 l 3 1 l -3 1 l -1 3 l -1 -3 l -3 -1 z"/>
<path d="M 86 30 l 0.8 -2.5 l 0.8 2.5 l 2.5 0.8 l -2.5 0.8 l -0.8 2.5 l -0.8 -2.5 l -2.5 -0.8 z"/>
<path d="M 84 12 l 0.6 -2 l 0.6 2 l 2 0.6 l -2 0.6 l -0.6 2 l -0.6 -2 l -2 -0.6 z" opacity="0.6"/>
</g>
<path d="M 8,100 Q 22,72 38,72 L 62,72 Q 78,72 92,100 Z" fill="#1a1320"/>
<path d="M 40,72 L 50,80 L 60,72 L 60,88 L 40,88 Z" fill="#ebe7df"/>
<polygon points="46,76 50,80 54,76 53,82 47,82" fill="#d4a544"/>
<ellipse cx="50" cy="48" rx="15" ry="18" fill="#f0d2ad"/>
<ellipse cx="50" cy="30" rx="22" ry="3" fill="#1a1320"/>
<rect x="36" y="6" width="28" height="24" fill="#1a1320"/>
<rect x="36" y="22" width="28" height="3" fill="#d4a544"/>
<path d="M 40,40 Q 44,37 46,40" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 54,40 Q 56,37 60,40" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<circle cx="43" cy="46" r="1.5" fill="#1a1320"/>
<circle cx="57" cy="46" r="1.5" fill="#1a1320"/>
<circle cx="57" cy="46" r="4" fill="none" stroke="#d4a544" stroke-width="0.9"/>
<line x1="60" y1="49" x2="64" y2="55" stroke="#d4a544" stroke-width="0.5"/>
<path d="M 38,56 Q 42,58 50,56 Q 58,58 62,56 Q 60,62 56,60 Q 52,58 50,58 Q 48,58 44,60 Q 40,62 38,56 Z" fill="#1a1320"/>
<path d="M 38,56 Q 33,54 34,52" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 62,56 Q 67,54 66,52" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
</svg>`,
    },

    cat: {
      label: "The Theatre Cat",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="42%" r="70%"><stop offset="0%" stop-color="#c45a3a"/><stop offset="100%" stop-color="#3a1810"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<path d="M 22,100 Q 22,76 50,76 Q 78,76 78,100 Z" fill="#161b22"/>
<polygon points="42,82 50,86 58,82 56,90 44,90" fill="#d4a544"/>
<circle cx="50" cy="86" r="1.6" fill="#1a1320"/>
<path d="M 26,52 Q 28,30 50,28 Q 72,30 74,52 Q 74,72 50,76 Q 26,72 26,52 Z" fill="#161b22"/>
<polygon points="32,32 28,18 40,28" fill="#161b22"/>
<polygon points="68,32 72,18 60,28" fill="#161b22"/>
<polygon points="35,28 33,22 38,27" fill="#d68aa1" opacity="0.7"/>
<polygon points="65,28 67,22 62,27" fill="#d68aa1" opacity="0.7"/>
<g transform="rotate(-12 50 18)">
<ellipse cx="50" cy="20" rx="20" ry="2.4" fill="#0a0d18"/>
<rect x="38" y="2" width="24" height="18" fill="#0a0d18"/>
<rect x="38" y="14" width="24" height="2.2" fill="#d4a544"/>
</g>
<ellipse cx="40" cy="50" rx="4" ry="5" fill="#f6d28a"/>
<ellipse cx="60" cy="50" rx="4" ry="5" fill="#f6d28a"/>
<ellipse cx="40" cy="50" rx="1.4" ry="3.4" fill="#161b22"/>
<ellipse cx="60" cy="50" rx="1.4" ry="3.4" fill="#161b22"/>
<path d="M 48,60 L 52,60 L 50,63 Z" fill="#d68aa1"/>
<path d="M 50,63 L 50,66 M 45,67 Q 47,69 50,66 Q 53,69 55,67" stroke="#161b22" stroke-width="0.9" fill="none" stroke-linecap="round"/>
<g stroke="#ebe7df" stroke-width="0.6" stroke-linecap="round" opacity="0.8">
<line x1="28" y1="62" x2="40" y2="64"/>
<line x1="28" y1="66" x2="40" y2="67"/>
<line x1="60" y1="64" x2="72" y2="62"/>
<line x1="60" y1="67" x2="72" y2="66"/>
</g>
</svg>`,
    },

    strongman: {
      label: "The Strongman",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="42%" r="74%"><stop offset="0%" stop-color="#c98a3a"/><stop offset="100%" stop-color="#3a2210"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<path d="M 4,100 Q 14,72 30,68 L 70,68 Q 86,72 96,100 Z" fill="#f0d2ad"/>
<path d="M 36,68 L 40,84 Q 50,80 60,84 L 64,68 Z" fill="#d4a544"/>
<g fill="#3a2210">
<circle cx="44" cy="74" r="1.4"/>
<circle cx="50" cy="76" r="1.2"/>
<circle cx="56" cy="74" r="1.4"/>
<circle cx="41" cy="80" r="1.0"/>
<circle cx="59" cy="80" r="1.0"/>
</g>
<rect x="40" y="58" width="20" height="14" fill="#f0d2ad"/>
<ellipse cx="50" cy="42" rx="16" ry="18" fill="#f0d2ad"/>
<ellipse cx="44" cy="30" rx="6" ry="3" fill="#fbe9c6" opacity="0.5"/>
<rect x="38" y="40" width="10" height="2" fill="#3a2210" rx="1"/>
<rect x="52" y="40" width="10" height="2" fill="#3a2210" rx="1"/>
<circle cx="43" cy="46" r="1.3" fill="#1a1320"/>
<circle cx="57" cy="46" r="1.3" fill="#1a1320"/>
<path d="M 24,54 Q 32,52 38,54 Q 44,58 50,56 Q 56,58 62,54 Q 68,52 76,54 Q 70,68 60,62 Q 54,60 50,60 Q 46,60 40,62 Q 30,68 24,54 Z" fill="#3a2210"/>
<path d="M 24,54 Q 18,50 16,46" stroke="#3a2210" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<path d="M 76,54 Q 82,50 84,46" stroke="#3a2210" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<line x1="48" y1="63" x2="52" y2="63" stroke="#3a2210" stroke-width="1" stroke-linecap="round"/>
</svg>`,
    },

    mime: {
      label: "The Mime",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="42%" r="72%"><stop offset="0%" stop-color="#5a8a78"/><stop offset="100%" stop-color="#1a2820"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<path d="M 16,100 Q 26,76 42,72 L 58,72 Q 74,76 84,100 Z" fill="#ebe7df"/>
<g stroke="#1a1320" stroke-width="3">
<line x1="22" y1="82" x2="42" y2="76"/>
<line x1="20" y1="90" x2="40" y2="84"/>
<line x1="22" y1="98" x2="44" y2="92"/>
<line x1="58" y1="76" x2="78" y2="82"/>
<line x1="60" y1="84" x2="80" y2="90"/>
<line x1="56" y1="92" x2="78" y2="98"/>
</g>
<rect x="44" y="60" width="12" height="14" fill="#ebe7df"/>
<ellipse cx="50" cy="44" rx="16" ry="19" fill="#f5f1e8"/>
<g transform="rotate(-15 50 20)">
<ellipse cx="50" cy="24" rx="20" ry="7" fill="#1a1320"/>
<circle cx="60" cy="14" r="2.2" fill="#1a1320"/>
<ellipse cx="46" cy="20" rx="6" ry="1.6" fill="#3a3f5a" opacity="0.6"/>
</g>
<path d="M 40,38 Q 43,34 47,38" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 53,38 Q 57,34 60,38" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<circle cx="43" cy="44" r="1.6" fill="#1a1320"/>
<circle cx="57" cy="44" r="1.6" fill="#1a1320"/>
<path d="M 43,47 Q 42,52 41,55 Q 40,52 41,49 Z" fill="#1a1320"/>
<ellipse cx="50" cy="54" rx="2.4" ry="3" fill="#a93030"/>
<path d="M 44,70 L 56,70 L 54,76 L 46,76 Z" fill="#d63a3a"/>
</svg>`,
    },

    ringmaster: {
      label: "The Ringmaster",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="42%" r="74%"><stop offset="0%" stop-color="#c43c3c"/><stop offset="100%" stop-color="#3a1018"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<path d="M 10,100 Q 22,72 38,70 L 62,70 Q 78,72 90,100 Z" fill="#a8261e"/>
<polygon points="38,70 50,80 50,100 32,100" fill="#1a1320"/>
<polygon points="62,70 50,80 50,100 68,100" fill="#1a1320"/>
<circle cx="50" cy="86" r="1.6" fill="#d4a544"/>
<circle cx="50" cy="93" r="1.6" fill="#d4a544"/>
<path d="M 36 80 l 1.2 -3.4 l 1.2 3.4 l 3.4 1.2 l -3.4 1.2 l -1.2 3.4 l -1.2 -3.4 l -3.4 -1.2 z" fill="#d4a544"/>
<polygon points="42,72 50,76 58,72 56,80 44,80" fill="#d4a544"/>
<rect x="44" y="60" width="12" height="12" fill="#f0d2ad"/>
<ellipse cx="50" cy="44" rx="14" ry="17" fill="#f0d2ad"/>
<ellipse cx="50" cy="30" rx="20" ry="2.6" fill="#1a1320"/>
<rect x="38" y="6" width="24" height="24" fill="#1a1320"/>
<path d="M 34,16 Q 50,12 66,16 L 66,22 Q 50,18 34,22 Z" fill="#ebe7df"/>
<path d="M 34,16 L 32,22" stroke="#ebe7df" stroke-width="1.5"/>
<path d="M 66,16 L 68,22" stroke="#ebe7df" stroke-width="1.5"/>
<text x="50" y="21" text-anchor="middle" font-family="Bebas Neue, Impact, sans-serif" font-size="6.4" fill="#1a1320" letter-spacing="0.5">MARQUEE</text>
<rect x="40" y="38" width="7" height="1.6" fill="#5a2818" rx="0.8"/>
<rect x="53" y="38" width="7" height="1.6" fill="#5a2818" rx="0.8"/>
<circle cx="43.5" cy="44" r="1.4" fill="#1a1320"/>
<circle cx="56.5" cy="44" r="1.4" fill="#1a1320"/>
<path d="M 38,53 Q 44,52 50,52 Q 56,52 62,53 Q 58,58 52,55 Q 50,54 48,55 Q 42,58 38,53 Z" fill="#5a2818"/>
<path d="M 38,53 Q 34,52 33,49" stroke="#5a2818" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 62,53 Q 66,52 67,49" stroke="#5a2818" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 46,58 Q 50,60 54,58" stroke="#5a2818" stroke-width="0.9" fill="none" stroke-linecap="round"/>
</svg>`,
    },

    lady: {
      label: "The Leading Lady",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="40%" r="72%"><stop offset="0%" stop-color="#b07a3a"/><stop offset="100%" stop-color="#3a2410"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<g stroke="#d4a544" stroke-width="0.6" opacity="0.45" fill="none">
<line x1="50" y1="30" x2="30" y2="6"/>
<line x1="50" y1="30" x2="40" y2="2"/>
<line x1="50" y1="30" x2="50" y2="0"/>
<line x1="50" y1="30" x2="60" y2="2"/>
<line x1="50" y1="30" x2="70" y2="6"/>
<line x1="50" y1="30" x2="20" y2="14"/>
<line x1="50" y1="30" x2="80" y2="14"/>
</g>
<path d="M 18,100 Q 28,76 40,72 L 60,72 Q 72,76 82,100 Z" fill="#1a1320"/>
<polygon points="40,72 60,72 50,90" fill="#3a1820"/>
<circle cx="50" cy="78" r="2.2" fill="#d4a544"/>
<circle cx="50" cy="78" r="0.9" fill="#fbe9c6"/>
<rect x="44" y="58" width="12" height="16" fill="#f0d2ad"/>
<ellipse cx="50" cy="42" rx="15" ry="18" fill="#f0d2ad"/>
<path d="M 32,38 Q 30,22 50,20 Q 70,22 68,38 Q 66,30 60,28 Q 56,32 50,30 Q 44,32 40,28 Q 34,30 32,38 Z" fill="#1a1320"/>
<g fill="#d4a544">
<path d="M 40,18 Q 28,4 36,2 Q 42,8 44,18 Z"/>
<path d="M 60,18 Q 72,4 64,2 Q 58,8 56,18 Z"/>
<path d="M 50,16 Q 52,2 50,0 Q 48,2 50,16 Z" fill="#f6d28a"/>
</g>
<rect x="38" y="18" width="24" height="3" fill="#1a1320"/>
<circle cx="50" cy="19.5" r="1.4" fill="#d4a544"/>
<path d="M 40,36 Q 44,32 47,36" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<path d="M 53,36 Q 56,32 60,36" stroke="#1a1320" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<ellipse cx="43" cy="42" rx="2.2" ry="1.4" fill="#1a1320"/>
<ellipse cx="57" cy="42" rx="2.2" ry="1.4" fill="#1a1320"/>
<path d="M 45.5,42 L 48,42.5" stroke="#1a1320" stroke-width="0.8" stroke-linecap="round"/>
<path d="M 54.5,42 L 52,42.5" stroke="#1a1320" stroke-width="0.8" stroke-linecap="round"/>
<circle cx="34" cy="48" r="1.4" fill="#d4a544"/>
<circle cx="66" cy="48" r="1.4" fill="#d4a544"/>
<path d="M 45,53 Q 50,57 55,53 Q 53,55 50,55 Q 47,55 45,53 Z" fill="#d63a3a"/>
<circle cx="57" cy="52" r="0.6" fill="#1a1320"/>
</svg>`,
    },

    child: {
      label: "The Child Star",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="40%" r="72%"><stop offset="0%" stop-color="#4a8c7a"/><stop offset="100%" stop-color="#142420"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<g fill="#f6d28a" opacity="0.7">
<path d="M 16 30 l 0.7 -2 l 0.7 2 l 2 0.7 l -2 0.7 l -0.7 2 l -0.7 -2 l -2 -0.7 z"/>
<path d="M 84 22 l 0.7 -2 l 0.7 2 l 2 0.7 l -2 0.7 l -0.7 2 l -0.7 -2 l -2 -0.7 z"/>
<path d="M 88 50 l 0.5 -1.5 l 0.5 1.5 l 1.5 0.5 l -1.5 0.5 l -0.5 1.5 l -0.5 -1.5 l -1.5 -0.5 z" opacity="0.5"/>
</g>
<path d="M 16,100 Q 26,78 40,74 L 60,74 Q 74,78 84,100 Z" fill="#d4a544"/>
<path d="M 38,74 L 36,100 L 40,100 L 42,74" fill="#a8261e"/>
<path d="M 62,74 L 64,100 L 60,100 L 58,74" fill="#a8261e"/>
<circle cx="40" cy="84" r="1.2" fill="#1a1320"/>
<circle cx="60" cy="84" r="1.2" fill="#1a1320"/>
<rect x="44" y="62" width="12" height="14" fill="#f0d2ad"/>
<ellipse cx="50" cy="46" rx="17" ry="18" fill="#f0d2ad"/>
<g fill="#7a3a18">
<circle cx="34" cy="34" r="6"/>
<circle cx="66" cy="34" r="6"/>
<circle cx="28" cy="44" r="5"/>
<circle cx="72" cy="44" r="5"/>
<circle cx="30" cy="54" r="4"/>
<circle cx="70" cy="54" r="4"/>
<circle cx="42" cy="30" r="6"/>
<circle cx="50" cy="28" r="6"/>
<circle cx="58" cy="30" r="6"/>
</g>
<g transform="translate(50,24)">
<path d="M -10,-2 Q -14,-8 -10,-10 L -2,-4 Z" fill="#a8261e"/>
<path d="M  10,-2 Q  14,-8  10,-10 L  2,-4 Z" fill="#a8261e"/>
<ellipse cx="0" cy="-3" rx="3" ry="3" fill="#a8261e"/>
<ellipse cx="0" cy="-3" rx="1.2" ry="1.2" fill="#d4a544"/>
</g>
<circle cx="42" cy="46" r="3" fill="#1a1320"/>
<circle cx="58" cy="46" r="3" fill="#1a1320"/>
<circle cx="43" cy="45" r="0.8" fill="#ebe7df"/>
<circle cx="59" cy="45" r="0.8" fill="#ebe7df"/>
<circle cx="36" cy="54" r="2.4" fill="#e08a8a" opacity="0.55"/>
<circle cx="64" cy="54" r="2.4" fill="#e08a8a" opacity="0.55"/>
<path d="M 44,58 Q 50,63 56,58" stroke="#5a2818" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<rect x="49" y="58" width="2" height="3" fill="#ebe7df" stroke="#5a2818" stroke-width="0.4"/>
</svg>`,
    },

    acrobat: {
      label: "The Acrobat",
      svg: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="40%" r="72%"><stop offset="0%" stop-color="#4a6a8c"/><stop offset="100%" stop-color="#101828"/></radialGradient></defs>
<rect width="100" height="100" fill="url(#bg)"/>
<line x1="20" y1="10" x2="80" y2="10" stroke="#8a92ac" stroke-width="2" stroke-linecap="round"/>
<line x1="32" y1="10" x2="32" y2="2" stroke="#8a92ac" stroke-width="0.8"/>
<line x1="68" y1="10" x2="68" y2="2" stroke="#8a92ac" stroke-width="0.8"/>
<path d="M 20,100 Q 30,72 42,70 L 58,70 Q 70,72 80,100 Z" fill="#a8261e"/>
<g stroke="#ebe7df" stroke-width="2.6">
<line x1="24" y1="84" x2="46" y2="78"/>
<line x1="22" y1="92" x2="44" y2="86"/>
<line x1="54" y1="78" x2="76" y2="84"/>
<line x1="56" y1="86" x2="78" y2="92"/>
</g>
<circle cx="50" cy="80" r="3.6" fill="#d4a544"/>
<path d="M 38,72 L 41,82" stroke="#a8261e" stroke-width="3" stroke-linecap="round"/>
<path d="M 62,72 L 59,82" stroke="#a8261e" stroke-width="3" stroke-linecap="round"/>
<rect x="44" y="58" width="12" height="14" fill="#f0d2ad"/>
<ellipse cx="50" cy="44" rx="14" ry="17" fill="#f0d2ad"/>
<path d="M 36,38 Q 36,22 50,20 Q 64,22 64,38 L 60,36 Q 58,28 50,28 Q 42,28 40,36 Z" fill="#3a1820"/>
<rect x="34" y="30" width="32" height="3" fill="#d4a544"/>
<circle cx="50" cy="31.5" r="1.6" fill="#a8261e"/>
<rect x="40" y="38" width="7" height="1.4" fill="#3a1820" rx="0.7" transform="rotate(-6 43.5 38.7)"/>
<rect x="53" y="38" width="7" height="1.4" fill="#3a1820" rx="0.7" transform="rotate(6 56.5 38.7)"/>
<circle cx="43.5" cy="44" r="1.4" fill="#1a1320"/>
<circle cx="56.5" cy="44" r="1.4" fill="#1a1320"/>
<path d="M 44,53 Q 50,55 56,53" stroke="#3a1820" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M 46,58 Q 50,60 54,58" stroke="#5a2818" stroke-width="0.9" fill="none" stroke-linecap="round"/>
</svg>`,
    },
  };

  // Ordered list — drives picker layout, deterministic-pick range.
  const IDS = Object.keys(PORTRAITS);

  // Each portrait's <defs><radialGradient id="bg"> uses the same
  // literal id, which collides when multiple avatars render on the
  // same page (the picker grid would show every tile in whichever
  // gradient appeared last). Rewrite the id per-call to a unique
  // suffix so each rendered instance keeps its own gradient.
  let counter = 0;
  function svg(id) {
    const entry = PORTRAITS[id] || PORTRAITS[IDS[0]];
    const uid = `mq${++counter}`;
    return entry.svg
      .replace(/id="bg"/g, `id="${uid}"`)
      .replace(/url\(#bg\)/g, `url(#${uid})`);
  }

  function label(id) {
    return (PORTRAITS[id] || PORTRAITS[IDS[0]]).label;
  }

  // Hash → portrait. Used as a fallback when an old profile or a
  // brand-new one has no avatar yet — same nick always picks the
  // same character so a familiar face shows up even before the
  // user opens the picker.
  function pickForNick(nick) {
    let h = 5381;
    const s = (nick || "").trim().toLowerCase();
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return IDS[Math.abs(h) % IDS.length];
  }

  function resolve(profile) {
    if (profile && profile.avatar && PORTRAITS[profile.avatar]) {
      return profile.avatar;
    }
    return pickForNick((profile && profile.nick) || "");
  }

  global.TheatrePortraits = { IDS, svg, label, pickForNick, resolve };
})(window);
