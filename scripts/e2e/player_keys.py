"""Web player keyboard regression (Playwright, headless Chromium).

Plays one Disk-library episode (local file: never an IPTV stream, so it can't
use the household's single upstream slot) and checks Right/Left = +/-10 s
whichever element has focus, repeated presses add up, Up/Down volume, space,
m, f, and that keys typed into an input do nothing. Restores the profile's
recents/watched/progress afterwards.

  python3 scripts/e2e/player_keys.py <base_url> <out_dir> <disk_series_id> <disk_episode_id>

The base URL must already be authenticated (e.g. a local proxy that adds the
session), and nobody should be watching: a Disk transcode takes the account's
stream slot like any other play."""
import os, sys, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1].rstrip("/"); OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
SERIES, EP = sys.argv[3], sys.argv[4]
res = []; errs = []
def note(ok, w): res.append(ok); print(("PASS " if ok else "FAIL ") + w, flush=True)
def pos(p): return p.evaluate("(state.playing && state.playing.transcodeAnchorSecs || 0) + document.getElementById('video').currentTime")
def settle(p, ms=1500): p.wait_for_timeout(ms)
def seek_check(p, key, focus_desc, expect):
    p.evaluate("document.getElementById('video').pause()"); settle(p, 600)
    a = pos(p); p.keyboard.press(key); settle(p, 1800); b = pos(p)
    d = b - a
    ok = abs(d - expect) <= 2.5
    note(ok, f"{key} with focus on {focus_desc}: moved {d:+.1f}s (want {expect:+d})")
with sync_playwright() as pw:
    br = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    snap = None
    pg.goto(BASE + f"/disk/open/{SERIES}")
    pg.wait_for_selector("#series-episodes .episode", timeout=30000)
    snap = pg.evaluate("async () => (await (await fetch('/api/bootstrap?lite=1')).json()).userState")
    try:
        pg.locator('.verso-tab[data-pane="episodes"]').click()
        pg.locator(f'#series-episodes .episode[data-ep-id="{EP}"]').click()
        pg.wait_for_function("() => { const v = document.getElementById('video'); return v && v.currentTime > 1 && !v.paused; }", timeout=90000)
        pg.evaluate("seekToSecs(300)")
        pg.wait_for_function("() => (state.playing.transcodeAnchorSecs||0) + document.getElementById('video').currentTime >= 299", timeout=90000)
        settle(pg, 4000)
        print("activeElement:", pg.evaluate("document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)"))
        print("transcode:", pg.evaluate("!!state.playing.transcode"))
        pg.evaluate("document.getElementById('video').pause()"); settle(pg, 600)
        a = pos(pg)
        for _ in range(3): pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(120)
        settle(pg, 2500); b = pos(pg)
        note(abs((b - a) - 30) <= 2.5, f"3 quick ArrowRight presses: moved {b-a:+.1f}s (want +30)")
        seek_check(pg, "ArrowRight", "as left after opening", 10)
        seek_check(pg, "ArrowLeft", "as left after opening", -10)
        pg.evaluate("document.activeElement && document.activeElement.blur()")
        seek_check(pg, "ArrowRight", "body", 10)
        seek_check(pg, "ArrowLeft", "body", -10)
        pg.evaluate("document.getElementById('video').setAttribute('tabindex','-1'); document.getElementById('video').focus()")
        seek_check(pg, "ArrowRight", "video element", 10)
        pg.locator("#player-playpause").focus()
        seek_check(pg, "ArrowRight", "a player button", 10)
        # space toggles
        pg.evaluate("document.activeElement.blur()")
        pg.evaluate("document.getElementById('video').play()"); settle(pg, 800)
        pg.keyboard.press(" "); settle(pg, 500)
        note(pg.evaluate("document.getElementById('video').paused"), "space pauses")
        pg.keyboard.press(" "); settle(pg, 800)
        note(not pg.evaluate("document.getElementById('video').paused"), "space resumes")
        m0 = pg.evaluate("document.getElementById('video').muted")
        pg.keyboard.press("m"); settle(pg, 300)
        note(pg.evaluate("document.getElementById('video').muted") != m0, "m toggles mute")
        pg.keyboard.press("m"); settle(pg, 300)
        v0 = pg.evaluate("document.getElementById('video').volume")
        pg.keyboard.press("ArrowDown"); settle(pg, 300)
        v1 = pg.evaluate("document.getElementById('video').volume")
        note(v1 < v0 or v0 == 0, f"ArrowDown lowers volume ({v0:.2f}->{v1:.2f})")
        pg.keyboard.press("ArrowUp"); settle(pg, 300)
        v2 = pg.evaluate("document.getElementById('video').volume")
        note(v2 > v1 or v1 == 1, f"ArrowUp raises volume ({v1:.2f}->{v2:.2f})")
        pg.keyboard.press("f"); settle(pg, 800)
        note(pg.evaluate("!!document.fullscreenElement"), "f enters fullscreen")
        pg.keyboard.press("f"); settle(pg, 800)
        note(pg.evaluate("!document.fullscreenElement"), "f leaves fullscreen")
        # typing in an input must not seek
        pg.evaluate("document.getElementById('video').pause()"); settle(pg, 400)
        pg.evaluate("() => { const i = document.createElement('input'); i.id = 'kt'; document.getElementById('player').appendChild(i); i.focus(); }")
        a = pos(pg); pg.keyboard.press("ArrowRight"); pg.keyboard.press("m"); settle(pg, 1200); b = pos(pg)
        note(abs(b - a) < 0.5 and not pg.evaluate("document.getElementById('video').muted"), f"keys in an input do nothing ({b-a:+.1f}s)")
        pg.evaluate("document.getElementById('kt').remove()")
        pg.screenshot(path=os.path.join(OUT, "player.png"))
    finally:
        pg.evaluate("() => { try { closePlayer(); } catch (e) {} }"); settle(pg, 800)
        if snap:
            body = {k: snap[k] for k in ("recents", "watched", "lastEpisode") if k in snap}
            pg.evaluate("async (b) => fetch('/api/user-state', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)})", body)
            prev = (snap.get("progress") or {}).get("disk:" + EP) or {}
            pg.evaluate("async ([id, p, d]) => fetch(`/api/progress/disk/${id}`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({position: p, duration: d})})", [EP, prev.get("p", 0), prev.get("d", 3000)])
            print("restored user state")
    print("console errors:", [e for e in errs][:10])
    br.close()
    print("RESULT", "PASS" if all(res) else "FAIL", f"{sum(res)}/{len(res)}")
