import base64
import http.server
import io
import json
import os
import socketserver
import threading
import zipfile

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

Handler = http.server.SimpleHTTPRequestHandler
Handler.log_message = lambda *a, **k: None


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

STATE_TEMPLATE = {
    "mode": "STATE_LOBBY",
    "creatorAddr": "SELF",
    "config": {
        "fields": ["name", "family", "city"],
        "rules": "",
        "letterSelection": "random",
        "timeLimit": 30,
        "enableStop": True,
        "stopDelay": 3,
        "stopConditionFull": False,
        "syncVoting": True,
    },
    "players": [
        {"addr": "SELF", "name": "Me", "ready": True},
        {"addr": "other1", "name": "Other", "ready": True},
    ],
    "activeRoundPlayers": [],
    "round": 1,
    "currentLetter": "",
    "turnIdx": 0,
    "scores": {},
    "answers": {},
    "stoppedBy": None,
    "currentFieldIdx": 0,
    "votes": {},
    "finalVotes": {},
    "kickVotes": {},
    "excludedPlayers": [],
    "roundStartTime": None,
    "stopUnlockTime": None,
}


def set_state(page, state):
    state["creatorAddr"] = page.evaluate("window.webxdc.selfAddr")
    state["players"][0]["addr"] = page.evaluate("window.webxdc.selfAddr")
    page.evaluate("localStorage.setItem('esmfamil_state', " + json.dumps(json.dumps(state)) + ")")
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(800)


with ReusableTCPServer(("127.0.0.1", 8768), Handler) as httpd:
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/bin/chromium")
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto("http://127.0.0.1:8768/index.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)

        # --- Scenario 0: app name & title (no hard-coded strings) ---
        print("=== SCENARIO 0: app name & title ===")
        print(f"  navigator.language: {page.evaluate('navigator.language')}")
        print(f"  document.title: {page.title()}")
        print(f"  header game title (default locale): {page.locator('h1').first.inner_text()}")
        page.evaluate("localStorage.setItem('esmfamil_lang', 'en')")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)
        print(f"  header game title (en): {page.locator('h1').first.inner_text()}")
        page.evaluate("localStorage.removeItem('esmfamil_lang')")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)

        # --- Scenario 1: stop delay lock with a game timer ---
        print("=== SCENARIO 1: stopDelay=3, timeLimit=30 ===")
        set_state(page, json.loads(json.dumps(STATE_TEMPLATE)))
        page.click("#btn-host-start-game")
        page.wait_for_selector("#btn-stop-game", timeout=5000)

        btn = page.locator("#btn-stop-game")
        disabled_at_start = btn.is_disabled()
        notice = page.locator("#stop-delay-notice")
        notice_visible = notice.is_visible()
        notice_text = notice.inner_text() if notice_visible else ""
        print(f"  at t=0 : disabled={disabled_at_start} delay_notice_visible={notice_visible} text='{notice_text}'")

        page.wait_for_timeout(1500)
        print(f"  at t=1.5s: notice text='{notice.inner_text()}'")

        # Fill fields to make sure unlock isn't blocked by stopConditionFull
        for i in range(3):
            page.fill(f"#field-{i}", f"answer{i}")

        # Wait past the unlock time
        deadline = 0
        for _ in range(30):
            if not btn.is_disabled():
                break
            page.wait_for_timeout(250)
            deadline += 250
        print(f"  unlocked after ~{deadline / 1000:.1f}s: disabled={btn.is_disabled()} delay_notice_visible={notice.is_visible()}")

        # --- Scenario 2: unlimited time, stop delay still unlocks ---
        print("=== SCENARIO 2: stopDelay=2, timeLimit=0 (unlimited) ===")
        s2 = json.loads(json.dumps(STATE_TEMPLATE))
        s2["config"]["timeLimit"] = 0
        s2["config"]["stopDelay"] = 2
        set_state(page, s2)
        page.click("#btn-host-start-game")
        page.wait_for_selector("#btn-stop-game", timeout=5000)
        btn = page.locator("#btn-stop-game")
        print(f"  at t=0 : disabled={btn.is_disabled()} notice='{page.locator('#stop-delay-notice').inner_text()}'")
        page.wait_for_timeout(3500)
        print(f"  after 3.5s: disabled={btn.is_disabled()} delay_notice_visible={page.locator('#stop-delay-notice').is_visible()}")

        # --- Scenario 3: mid-game joiner during vote collection ---
        print("=== SCENARIO 3: mid-game joiner in STATE_COLLECTING_VOTES ===")
        s3 = json.loads(json.dumps(STATE_TEMPLATE))
        s3["mode"] = "STATE_COLLECTING_VOTES"
        s3["activeRoundPlayers"] = ["other1"]
        s3["currentLetter"] = "ب"
        set_state(page, s3)
        body = page.inner_text("body")
        print(f"  shows waiting screen: {'در انتظار پایان دست فعلی' in body or 'Waiting for round to finish' in body}")

        # --- Scenario 4: VOTE_KICK alert fires, no dead kicked_alerted_ localStorage keys ---
        print("=== SCENARIO 4: VOTE_KICK alert without kicked_alerted_ localStorage ===")
        s4 = json.loads(json.dumps(STATE_TEMPLATE))
        set_state(page, s4)
        self_addr = page.evaluate("window.webxdc.selfAddr")

        alerts = []
        page.once("dialog", lambda d: (alerts.append(d.message), d.accept()))
        page.evaluate(
            "(target) => window.webxdc.sendUpdate({ payload: { type: 'VOTE_KICK', targetAddr: target, voterAddr: 'other1' } })",
            self_addr,
        )
        page.wait_for_timeout(800)
        keys = page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('kicked_alerted_'))")
        print(f"  alert fired: {len(alerts) > 0}")
        print(f"  alert message: {alerts[0] if alerts else '(none)'}")
        print(f"  kicked_alerted_ keys: {keys or '(none)'}")

        # --- Scenario 5: in-app XDC build bundles icon.png ---
        print("=== SCENARIO 5: in-app XDC build bundles icon.png ===")
        page.evaluate("localStorage.removeItem('esmfamil_state'); localStorage.removeItem('esmfamil_lang')")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)

        page.evaluate("window.webxdc.sendToChat = async (msg) => { window.__lastShare = msg; }")
        page.fill("#cfg-fields", "name\nfamily\ncity")
        page.click("#btn-share")
        share = None
        for _ in range(60):
            share = page.evaluate("window.__lastShare")
            if share and share.get("file"):
                break
            page.wait_for_timeout(250)
        xdc_bytes = None
        if share and share.get("file"):
            xdc_bytes = base64.b64decode(share["file"]["base64"])

        if xdc_bytes:
            with zipfile.ZipFile(io.BytesIO(xdc_bytes)) as zf:
                names = zf.namelist()
                manifest = zf.read("manifest.toml").decode("utf-8")
                has_icon = "icon.png" in names
                icon_head = zf.read("icon.png")[:8] if has_icon else b""
            print(f"  entries: {sorted(names)}")
            print(f"  manifest references icon: {'icon = ' in manifest}")
            print(f"  icon.png bundled: {has_icon}")
            print(f"  icon is PNG: {icon_head == b'\x89PNG\r\n\x1a\n'}")
        else:
            print(f"  build failed: {share}")

        # --- Scenario 6: reopening a finished game lands in the lobby, no alert ---
        print("=== SCENARIO 6: reopen finished game -> lobby, no expired alert ===")
        s6 = json.loads(json.dumps(STATE_TEMPLATE))
        s6["mode"] = "STATE_SCORE"
        s6["scores"] = {"SELF": {"total": 10, "thisRound": 10}}
        set_state(page, s6)

        alerts6 = []
        page.on("dialog", lambda d: (alerts6.append(d.message), d.accept()))

        # Simulate the runtime replaying the whole round's update log on open,
        # ending with the update that carries serial == max_serial.
        page.evaluate(
            """() => {
                const send = (serial, maxSerial, payload) =>
                    window.webxdc.sendUpdate({ serial, max_serial: maxSerial, payload });
                const self = window.webxdc.selfAddr;
                send(1, 5, { type: 'JOIN', addr: self, name: 'Me', creatorAddr: self });
                send(2, 5, { type: 'JOIN', addr: 'other1', name: 'Other', creatorAddr: self });
                send(3, 5, { type: 'START_GAME', hostAddr: self, letter: 'ب', activePlayers: [self, 'other1'], startTime: Date.now() - 120000 });
                send(4, 5, { type: 'SUBMIT_ANSWERS', addr: self, answers: ['ali', 'alavi', 'tehran'] });
                send(5, 5, { type: 'FINISH_VOTING', finalVotes: {}, scores: { [self]: { total: 10, thisRound: 10 }, other1: { total: 0, thisRound: 0 } } });
            }"""
        )
        page.wait_for_timeout(1200)
        mode = page.evaluate("window.app.state.mode")
        print(f"  final mode: {mode} (expected STATE_LOBBY)")
        print(f"  alerts during replay: {alerts6 or '(none)'}")

        print("pageerrors:", errors or "(none)")
        browser.close()
