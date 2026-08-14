import http.server
import json
import os
import socketserver
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

Handler = http.server.SimpleHTTPRequestHandler
Handler.log_message = lambda *a, **k: None

with socketserver.TCPServer(("127.0.0.1", 8769), Handler) as httpd:
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/bin/chromium")
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto("http://127.0.0.1:8769/index.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)

        self_addr = page.evaluate("window.webxdc.selfAddr")
        state = {
            "mode": "STATE_LOBBY",
            "creatorAddr": self_addr,
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
                {"addr": self_addr, "name": "Me", "ready": True},
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
        page.evaluate("localStorage.setItem('esmfamil_state', " + json.dumps(json.dumps(state)) + ")")
        page.reload()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1200)

        print("=== BODY ===")
        print(page.inner_text("body")[:900])
        print("=== STATE ===")
        print(page.evaluate("JSON.stringify(window.app.state, null, 1)"))
        print("pageerrors:", errors or "(none)")
        browser.close()
