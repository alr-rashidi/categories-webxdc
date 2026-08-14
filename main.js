// WebXDC Fallback Mock for local browser development if webxdc.js is not present
if (!window.webxdc) {
  // Keep the mock identity stable across reloads so saved states stay coherent
  let mockAddr = null;
  try {
    mockAddr = localStorage.getItem("webxdc_mock_selfaddr");
  } catch (e) { }
  if (!mockAddr) {
    mockAddr = "user_" + Math.floor(Math.random() * 10000);
    try {
      localStorage.setItem("webxdc_mock_selfaddr", mockAddr);
    } catch (e) { }
  }
  window.webxdc = {
    sendUpdate: (update, description) => {
      console.log("Mock WebXDC sendUpdate:", update, description);
      setTimeout(() => {
        if (window.webxdc.setUpdateListener.listener) {
          window.webxdc.setUpdateListener.listener(update);
        }
      }, 100);
    },
    setUpdateListener: (cb, serial) => {
      window.webxdc.setUpdateListener.listener = cb;
      return Promise.resolve();
    },
    selfAddr: mockAddr,
    selfName: "Player " + Math.floor(Math.random() * 100),
    sendToChat: async (message) => {
      console.log("Mock WebXDC sendToChat (Browser preview mode):", message);
    },
  };
}

const webxdc = window.webxdc;

// App identity + version, kept in one place (also mirrored in manifest.toml)
const APP_NAME = "Categories";
const APP_VERSION = "1.0.0";

function crc32(uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < uint8Array.length; i++) {
    crc ^= uint8Array[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const enc = new TextEncoder();
  const fileEntries = [];
  let offset = 0;
  const chunks = [];

  for (const [path, file] of Object.entries(files)) {
    const dataBytes = file.data;
    const compressedSize = dataBytes.length;
    const uncompressedSize = file.uncompressedSize;
    const compressionMethod = file.compressed ? 8 : 0;
    const crc = file.crc;

    const nameBytes = enc.encode(path);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);

    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, compressionMethod, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, dataBytes);

    fileEntries.push({
      nameBytes,
      crc,
      compressedSize,
      uncompressedSize,
      offset,
      compressionMethod,
    });

    offset += localHeader.length + dataBytes.length;
  }

  // Central Directory
  const cdChunks = [];
  let cdSize = 0;
  for (const fe of fileEntries) {
    const cdHeader = new Uint8Array(46 + fe.nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, fe.compressionMethod, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, fe.crc, true);
    cv.setUint32(20, fe.compressedSize, true);
    cv.setUint32(24, fe.uncompressedSize, true);
    cv.setUint16(28, fe.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, fe.offset, true);
    cdHeader.set(fe.nameBytes, 46);

    cdChunks.push(cdHeader);
    cdSize += cdHeader.length;
  }

  // EOCD
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, fileEntries.length, true);
  ev.setUint16(10, fileEntries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [chunks, cdChunks, [eocd]].flat();
  const result = new Uint8Array(all.reduce((sum, c) => sum + c.length, 0));
  let pos = 0;
  for (const c of all) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
}

function uint8ArrayToBase64(uint8) {
  let binary = "";
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

async function compressBytes(uint8Array, format) {
  const stream = new Blob([uint8Array])
    .stream()
    .pipeThrough(new CompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// Compress with raw DEFLATE (RFC 1951) as required by ZIP entries.
// Falls back gracefully: 'deflate-raw' -> zlib 'deflate' with the 2-byte
// header and 4-byte Adler-32 trailer stripped -> stored (uncompressed)
// when the Compression Streams API is unavailable.
async function deflateBytes(uint8Array) {
  if (typeof CompressionStream === "undefined") {
    return { data: uint8Array, compressed: false };
  }
  let raw;
  try {
    raw = await compressBytes(uint8Array, "deflate-raw");
  } catch (e) {
    try {
      const zlib = await compressBytes(uint8Array, "deflate");
      raw = zlib.slice(2, zlib.length - 4); // strip zlib header + Adler-32
    } catch (e2) {
      return { data: uint8Array, compressed: false };
    }
  }
  // Only use compression when it actually shrinks the entry
  if (raw.length >= uint8Array.length) {
    return { data: uint8Array, compressed: false };
  }
  return { data: raw, compressed: true };
}

async function createXdcZip(config) {
  const enc = new TextEncoder();
  async function makeEntry(str) {
    const data = enc.encode(str);
    const { data: payload, compressed } = await deflateBytes(data);
    return {
      data: payload,
      uncompressedSize: data.length,
      compressed,
      crc: crc32(data),
    };
  }

  async function makeBinaryEntry(uint8) {
    const { data: payload, compressed } = await deflateBytes(uint8);
    return {
      data: payload,
      uncompressedSize: uint8.length,
      compressed,
      crc: crc32(uint8),
    };
  }

  const files = {};

  // 1. manifest.toml
  const manifestToml = `name = ${JSON.stringify(APP_NAME)}
description = ${JSON.stringify(t("manifestDescription"))}
version = ${JSON.stringify(APP_VERSION)}
icon = "icon.png"
`;
  files["manifest.toml"] = await makeEntry(manifestToml);

  // 2. game_config.json
  files["game_config.json"] = await makeEntry(JSON.stringify(config, null, 2));

  // 3. HTML shell & source files
  try {
    const htmlRes = await fetch("./index.html").catch(() => null);
    if (htmlRes && htmlRes.ok) {
      files["index.html"] = await makeEntry(await htmlRes.text());
    } else {
      files["index.html"] = await makeEntry(
        `<!DOCTYPE html><html lang="${currentLang}" dir="${currentLang === "fa" ? "rtl" : "ltr"}"><head><meta charset="UTF-8"><title>${APP_NAME}</title><script src="webxdc.js"></script><link rel="stylesheet" href="./index.css"></head><body><div id="root"></div><script src="./i18n.js"></script><script type="module" src="./main.js"></script></body></html>`,
      );
    }

    const jsRes = await fetch("./main.js").catch(() => null);
    if (jsRes && jsRes.ok) {
      files["main.js"] = await makeEntry(await jsRes.text());
    }

    const i18nRes = await fetch("./i18n.js").catch(() => null);
    if (i18nRes && i18nRes.ok) {
      files["i18n.js"] = await makeEntry(await i18nRes.text());
    }

    const cssRes = await fetch("./index.css").catch(() => null);
    if (cssRes && cssRes.ok) {
      files["index.css"] = await makeEntry(await cssRes.text());
    }

    // 4. icon.png (the manifest references it, so it must be bundled)
    const iconRes = await fetch("./icon.png").catch(() => null);
    if (iconRes && iconRes.ok) {
      files["icon.png"] = await makeBinaryEntry(
        new Uint8Array(await iconRes.arrayBuffer()),
      );
    }
  } catch (e) {
    console.warn("Using default zip structure for XDC package", e);
  }

  const zipBytes = buildZip(files);
  const base64Data = uint8ArrayToBase64(zipBytes);

  return { base64Data };
}

function getInitialLanguage() {
  const saved = localStorage.getItem("esmfamil_lang");
  if (saved) return saved;
  const navLangs = navigator.languages || [
    navigator.language || navigator.userLanguage || "",
  ];
  for (const lang of navLangs) {
    if (!lang) continue;
    const lower = lang.toLowerCase();
    if (lower.startsWith("fa")) return "fa";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

let currentLang = getInitialLanguage();
// DEFAULT THEME IS DARK as explicitly requested
let currentTheme = localStorage.getItem("esmfamil_theme") || "dark";

const t = (key) => {
  if (i18n[currentLang] && i18n[currentLang][key]) {
    return i18n[currentLang][key];
  }
  return i18n.en[key] || key;
};

// --- Main Application Class ---
class GameApp {
  constructor() {
    this.root = document.getElementById("root");
    this.timerInterval = null;
    this.timeLeft = 0;
    this.activeModalPlayer = null; // for scoreboard answer inspector modal
    this.isInitialLoad = true;
    setTimeout(() => {
      this.isInitialLoad = false;
    }, 500);
    // Becomes true once the runtime has replayed the stored update log on open.
    // Used to avoid re-running an already-finished round during the replay.
    this.initialReplayDone = false;

    this.applyTheme();
    this.loadState();
    this.setupXDC();
    this.render();
    this.checkGameConfigPackage();
  }

  applyTheme() {
    if (currentTheme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
      document.documentElement.style.colorScheme = "dark";
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      document.documentElement.style.colorScheme = "light";
    }
    document.documentElement.setAttribute(
      "dir",
      currentLang === "fa" ? "rtl" : "ltr",
    );
    document.documentElement.setAttribute("lang", currentLang);
  }

  loadState() {
    const defaultState = {
      mode: "STATE_CREATOR",
      creatorAddr: null,
      config: {
        fields: t("classicFieldsList").split("\n"),
        rules: t("defaultRules"),
        letterSelection: "random",
        timeLimit: 60,
        enableStop: true,
        stopDelay: 5,
        stopConditionFull: true,
        syncVoting: true,
      },
      players: [], // [{ addr, name, ready }]
      activeRoundPlayers: [], // [addr1, addr2] addresses of players who started current round
      round: 1,
      currentLetter: "",
      turnIdx: 0,
      scores: {}, // { addr: { total: 0, thisRound: 0 } }
      answers: {}, // { addr: { fieldIdx: 'answer' } }
      stoppedBy: null,
      currentFieldIdx: 0,
      votes: {}, // { targetAddr: { voterAddr: true/false } }
      finalVotes: {}, // { fieldIdx: { addr: boolean } }
      kickVotes: {}, // { targetAddr: [voterAddr1, voterAddr2] }
      excludedPlayers: [], // [addr1, addr2] addresses of players excluded from voting
      roundStartTime: null,
      stopUnlockTime: null, // timestamp after which the Stop button unlocks
    };

    try {
      const saved = localStorage.getItem("esmfamil_state");
      if (saved) {
        this.state = { ...defaultState, ...JSON.parse(saved) };
      } else {
        this.state = defaultState;
      }
    } catch (e) {
      this.state = defaultState;
    }
    if (!this.state.kickVotes) this.state.kickVotes = {};
    if (!Array.isArray(this.state.excludedPlayers))
      this.state.excludedPlayers = [];

    // Check if re-entering an active game whose time limit has expired
    if (
      this.state.mode === "STATE_PLAYING" &&
      this.state.config?.timeLimit > 0 &&
      this.state.roundStartTime
    ) {
      const elapsed = Math.floor(
        (Date.now() - this.state.roundStartTime) / 1000,
      );
      if (elapsed >= this.state.config.timeLimit) {
        setTimeout(() => {
          alert(t("gameExpiredAlert"));
          this.state.mode = "STATE_LOBBY";
          this.saveState();
          this.render();
        }, 100);
      }
    }
  }

  saveState() {
    localStorage.setItem("esmfamil_state", JSON.stringify(this.state));
  }

  getHostAddr() {
    if (this.state.creatorAddr) {
      const creatorPlayer = this.state.players.find(
        (p) => p.addr === this.state.creatorAddr,
      );
      if (creatorPlayer) {
        return this.state.creatorAddr;
      }
    }
    return this.state.players[0]?.addr || null;
  }

  getActiveRoundPlayers() {
    if (
      !Array.isArray(this.state.activeRoundPlayers) ||
      this.state.activeRoundPlayers.length === 0
    ) {
      return this.state.players;
    }
    const filtered = this.state.players.filter((p) =>
      this.state.activeRoundPlayers.includes(p.addr),
    );
    return filtered.length > 0 ? filtered : this.state.players;
  }

  isMidGameJoiner() {
    if (
      this.state.mode !== "STATE_PLAYING" &&
      this.state.mode !== "STATE_VOTING" &&
      this.state.mode !== "STATE_COLLECTING_VOTES"
    ) {
      return false;
    }
    if (
      Array.isArray(this.state.activeRoundPlayers) &&
      this.state.activeRoundPlayers.length > 0
    ) {
      return !this.state.activeRoundPlayers.includes(webxdc.selfAddr);
    }
    return false;
  }

  async checkGameConfigPackage() {
    try {
      const res = await fetch("./game_config.json");
      if (res.ok) {
        const config = await res.json();
        if (
          config &&
          Array.isArray(config.fields) &&
          config.fields.length > 0
        ) {
          this.state.config = { ...this.state.config, ...config };
          if (config.creatorAddr) {
            this.state.creatorAddr = config.creatorAddr;
          }
          if (this.state.mode === "STATE_CREATOR") {
            this.state.mode = "STATE_LOBBY";
            this.broadcastJoin();
          }
          this.saveState();
          this.render();
        }
      }
    } catch (e) {
      // Standalone creator mode without package config
    }
  }

  setupXDC() {
    webxdc.setUpdateListener((update) => {
      const payload = update.payload;
      if (!payload) return;

      if (this.state.mode === "STATE_CREATOR") {
        this.state.mode = "STATE_LOBBY";
        this.broadcastJoin();
      }

      if (payload.type === "JOIN") {
        if (payload.creatorAddr) {
          this.state.creatorAddr = payload.creatorAddr;
        }
        const exists = this.state.players.find((p) => p.addr === payload.addr);
        if (!exists) {
          this.state.players.push({
            addr: payload.addr,
            name: payload.name,
            ready: false,
          });
        }
        if (!this.state.creatorAddr && this.state.players.length > 0) {
          this.state.creatorAddr = this.state.players[0].addr;
        }
        if (this.state.kickVotes && this.state.kickVotes[payload.addr]) {
          delete this.state.kickVotes[payload.addr];
        }
      } else if (payload.type === "START_GAME") {
        const hostP = this.state.players.find(
          (p) => p.addr === payload.hostAddr || p.addr === this.getHostAddr(),
        );
        if (hostP) hostP.ready = true;
        if (payload.letter) {
          this.state.currentLetter = payload.letter;
          this.state.inLetterSelection = false;
          this.state.fieldCompleted = {};
          if (payload.activePlayers && payload.activePlayers.length > 0) {
            this.state.activeRoundPlayers = payload.activePlayers;
          } else {
            this.state.activeRoundPlayers = this.state.players.map(
              (p) => p.addr,
            );
          }
          this.startGameplay(payload.startTime);
        } else {
          this.startLetterSelection();
        }
      } else if (payload.type === "READY") {
        const p = this.state.players.find((p) => p.addr === payload.addr);
        if (p) p.ready = true;
      } else if (payload.type === "UNREADY") {
        const p = this.state.players.find((p) => p.addr === payload.addr);
        if (p) p.ready = false;
      } else if (payload.type === "VOTE_KICK") {
        if (!this.state.kickVotes) this.state.kickVotes = {};
        if (!this.state.kickVotes[payload.targetAddr]) {
          this.state.kickVotes[payload.targetAddr] = [];
        }
        const votesArr = this.state.kickVotes[payload.targetAddr];
        const idx = votesArr.indexOf(payload.voterAddr);
        if (idx > -1) {
          votesArr.splice(idx, 1);
        } else {
          votesArr.push(payload.voterAddr);
        }

        const totalPlayers = this.state.players.length;
        const otherPlayersCount = totalPlayers - 1;
        if (
          otherPlayersCount > 0 &&
          votesArr.length / otherPlayersCount >= 0.5
        ) {
          const kickedP = this.state.players.find(
            (p) => p.addr === payload.targetAddr,
          );
          this.state.players = this.state.players.filter(
            (p) => p.addr !== payload.targetAddr,
          );
          delete this.state.kickVotes[payload.targetAddr];

          if (payload.targetAddr === webxdc.selfAddr) {
            const isHistorical =
              update.serial &&
              update.max_serial &&
              update.serial < update.max_serial;
            if (!isHistorical && !this.isInitialLoad) {
              alert(t("kickedNotice"));
            }
          }

          this.checkAllReady();
        }
      } else if (payload.type === "SET_LETTER") {
        this.state.currentLetter = payload.letter;
        this.state.fieldCompleted = {};
        if (payload.activePlayers && payload.activePlayers.length > 0) {
          this.state.activeRoundPlayers = payload.activePlayers;
        } else if (
          !this.state.activeRoundPlayers ||
          this.state.activeRoundPlayers.length === 0
        ) {
          this.state.activeRoundPlayers = this.state.players.map((p) => p.addr);
        }
        this.startGameplay(payload.startTime);
      } else if (payload.type === "SKIP_MISSING_ANSWERS") {
        this.state.excludedPlayers = payload.missingPlayers || [];
        this.transitionToVoting(payload.activeVotingPlayers);
      } else if (payload.type === "FIELD_VOTE_DONE") {
        if (!this.state.fieldCompleted) this.state.fieldCompleted = {};
        if (!this.state.fieldCompleted[payload.fIdx])
          this.state.fieldCompleted[payload.fIdx] = {};
        this.state.fieldCompleted[payload.fIdx][payload.addr] = true;
        this.render();
      } else if (payload.type === "STOP_GAME") {
        this.state.stoppedBy = payload.addr;
        this.endGameplay(payload.answers);
      } else if (payload.type === "SUBMIT_ANSWERS") {
        this.state.answers[payload.addr] = payload.answers;
        this.checkAllAnswersSubmitted();
      } else if (payload.type === "FINALIZE_ASYNC_VOTING") {
        if (!this.state.asyncFinishedVoters)
          this.state.asyncFinishedVoters = {};
        if (!this.state.collectedJudgments) this.state.collectedJudgments = {};
        this.state.asyncFinishedVoters[payload.addr] = true;
        this.state.collectedJudgments[payload.addr] = payload.localVotes || {};

        const activePlayers = this.getActiveRoundPlayers();
        const finishedCount = activePlayers.filter(
          (p) => this.state.asyncFinishedVoters[p.addr],
        ).length;
        const halfCount = Math.ceil(activePlayers.length / 2);

        if (finishedCount >= halfCount && !this.state.votingCountdownEnd) {
          const endTime = Date.now() + 20000;
          this.state.votingCountdownEnd = endTime;
          this.startVotingCountdown();
          if (this.getHostAddr() === webxdc.selfAddr) {
            webxdc.sendUpdate({
              payload: { type: "START_VOTING_COUNTDOWN", endTime: endTime },
            });
          }
        }

        if (finishedCount >= activePlayers.length) {
          this.startCollectingJudgments();
        } else {
          this.render();
        }
      } else if (payload.type === "START_VOTING_COUNTDOWN") {
        this.state.votingCountdownEnd = payload.endTime;
        this.startVotingCountdown();
        this.render();
      } else if (payload.type === "NEXT_FIELD") {
        this.state.currentFieldIdx++;
        this.render();
      } else if (payload.type === "SUBMIT_JUDGMENTS_START") {
        this.state.mode = "STATE_COLLECTING_VOTES";
        this.state.collectedJudgments = {};
        this.showForceAnnounceBtn = false;

        // Send my local votes
        webxdc.sendUpdate({
          payload: {
            type: "SUBMIT_PLAYER_JUDGMENTS",
            addr: webxdc.selfAddr,
            judgments: this.localVotes || {},
          },
        });

        // Start 10s timer for creator
        if (this.collectingTimer) clearTimeout(this.collectingTimer);
        this.collectingTimer = setTimeout(() => {
          if (this.state.mode === "STATE_COLLECTING_VOTES") {
            this.showForceAnnounceBtn = true;
            this.render();
          }
        }, 10000);

        this.render();
      } else if (payload.type === "SUBMIT_PLAYER_JUDGMENTS") {
        if (!this.state.collectedJudgments) this.state.collectedJudgments = {};
        this.state.collectedJudgments[payload.addr] = payload.judgments;

        const activePlayers = this.getActiveRoundPlayers();
        const allReceived = activePlayers.every(
          (p) => this.state.collectedJudgments[p.addr],
        );
        const isHost = this.getHostAddr() === webxdc.selfAddr;

        if (allReceived && isHost) {
          this.announceResults();
        } else {
          this.render();
        }
      } else if (payload.type === "FINISH_VOTING") {
        if (this.collectingTimer) clearTimeout(this.collectingTimer);
        this.state.finalVotes = payload.finalVotes;
        this.state.scores = payload.scores;
        this.state.mode = "STATE_SCORE";
        this.state.players.forEach((p) => (p.ready = false));
      } else if (payload.type === "PLAY_AGAIN") {
        const p = this.state.players.find((p) => p.addr === payload.addr);
        if (p) p.ready = true;
        this.checkAllPlayAgain();
      } else if (payload.type === "KICK") {
        this.state.players = this.state.players.filter(
          (p) => p.addr !== payload.targetAddr,
        );
        this.checkAllReady();
        this.checkAllPlayAgain();
      }

      // Initial replay finished (last stored update seen): if the round has
      // already fully ended, go straight to the lobby instead of re-showing
      // the previous round's results.
      if (
        !this.initialReplayDone &&
        update.serial &&
        update.max_serial &&
        update.serial === update.max_serial
      ) {
        this.initialReplayDone = true;
        if (this.state.mode === "STATE_SCORE") {
          this.state.mode = "STATE_LOBBY";
          this.state.players.forEach((p) => (p.ready = false));
          this.state.activeRoundPlayers = [];
          this.state.answers = {};
          this.state.stoppedBy = null;
          this.state.currentFieldIdx = 0;
          this.state.excludedPlayers = [];
        }
      }

      this.saveState();
      this.render();
    }, 0);

    // Auto join broadcast if in game lobby or gameplay
    if (this.state.mode !== "STATE_CREATOR") {
      this.broadcastJoin();
    }
  }

  broadcastJoin() {
    if (!this.state.creatorAddr && webxdc.selfAddr) {
      if (this.state.mode === "STATE_CREATOR") {
        this.state.creatorAddr = webxdc.selfAddr;
      } else if (this.state.players.length > 0) {
        this.state.creatorAddr = this.state.players[0].addr;
      } else {
        this.state.creatorAddr = webxdc.selfAddr;
      }
    }
    const exists = this.state.players.find((p) => p.addr === webxdc.selfAddr);
    const count = exists
      ? this.state.players.length
      : this.state.players.length > 0
        ? this.state.players.length + 1
        : 1;
    const summaryText = t("playersCountSummary").replace("{count}", count);
    webxdc.sendUpdate(
      {
        payload: {
          type: "JOIN",
          addr: webxdc.selfAddr,
          name: webxdc.selfName,
          creatorAddr: this.state.creatorAddr,
        },
        summary: summaryText,
        info: summaryText,
      },
      `${webxdc.selfName} ${t("joinedStatus")}`,
    );
  }

  checkAllReady() {
    if (this.state.mode !== "STATE_LOBBY") return;
    // Require AT LEAST 2 players to start
    if (this.state.players.length < 2) return;

    const allReady = this.state.players.every((p) => p.ready);
    const isHost = this.getHostAddr() === webxdc.selfAddr;
    if (allReady && isHost) {
      this.startLetterSelection();
    }
  }

  checkAllPlayAgain() {
    if (this.state.mode !== "STATE_SCORE") return;
    if (this.state.players.length < 2) return;

    const allReady = this.state.players.every((p) => p.ready);
    if (allReady) {
      this.state.mode = "STATE_LOBBY";
      this.state.players.forEach((p) => (p.ready = false));
      this.state.activeRoundPlayers = []; // reset active players for new round lobby
      this.state.round++;
      this.state.answers = {};
      this.state.stoppedBy = null;
      this.saveState();
      this.render();
    }
  }

  checkAllAnswersSubmitted() {
    if (this.state.mode !== "STATE_PLAYING") return;
    const activePlayers = this.getActiveRoundPlayers();
    const allSubmitted = activePlayers.every((p) => this.state.answers[p.addr]);
    if (allSubmitted) {
      if (this.answersCollectionTimer)
        clearTimeout(this.answersCollectionTimer);
      this.transitionToVoting(activePlayers.map((p) => p.addr));
      return;
    }

    if (!this.answersCollectionTimerStarted) {
      this.answersCollectionTimerStarted = true;
      this.showSkipMissingBtn = false;
      if (this.answersCollectionTimer)
        clearTimeout(this.answersCollectionTimer);
      this.answersCollectionTimer = setTimeout(() => {
        this.showSkipMissingBtn = true;
        this.render();
      }, 10000);
    }
    this.render();
  }

  transitionToVoting(votersList) {
    if (this.answersCollectionTimer) clearTimeout(this.answersCollectionTimer);
    this.state.mode = "STATE_VOTING";
    if (votersList && votersList.length > 0) {
      this.state.activeRoundPlayers = votersList;
    }
    this.state.currentFieldIdx = 0;
    this.localVotingFieldIdx = 0;
    this.state.asyncFinishedVoters = {};
    this.state.collectedJudgments = {};
    this.state.votingCountdownEnd = null;
    if (this.votingCountdownInterval) {
      clearInterval(this.votingCountdownInterval);
      this.votingCountdownInterval = null;
    }
    this.state.votes = {};
    this.state.finalVotes = {};
    this.localVotes = {};
    (this.state.config.fields || []).forEach((_, fIdx) => {
      this.localVotes[fIdx] = {};
    });
    this.saveState();
    this.render();
  }

  startVotingCountdown() {
    if (this.votingCountdownInterval)
      clearInterval(this.votingCountdownInterval);

    this.votingCountdownInterval = setInterval(() => {
      if (this.state.mode !== "STATE_VOTING") {
        clearInterval(this.votingCountdownInterval);
        this.votingCountdownInterval = null;
        return;
      }

      const remaining = Math.max(
        0,
        Math.ceil((this.state.votingCountdownEnd - Date.now()) / 1000),
      );

      const el = document.getElementById("voting-countdown-display");
      if (el) {
        el.innerText = remaining.toString();
      }

      if (remaining <= 0) {
        clearInterval(this.votingCountdownInterval);
        this.votingCountdownInterval = null;
        this.onVotingCountdownExpired();
      }
    }, 1000);
  }

  onVotingCountdownExpired() {
    if (this.state.mode !== "STATE_VOTING") return;

    if (!this.state.asyncFinishedVoters?.[webxdc.selfAddr]) {
      if (!this.state.asyncFinishedVoters) this.state.asyncFinishedVoters = {};
      this.state.asyncFinishedVoters[webxdc.selfAddr] = true;
      webxdc.sendUpdate({
        payload: {
          type: "FINALIZE_ASYNC_VOTING",
          addr: webxdc.selfAddr,
          localVotes: this.localVotes || {},
        },
      });
    }

    this.startCollectingJudgments();
  }

  startCollectingJudgments() {
    if (this.state.mode !== "STATE_VOTING") return;

    if (!this.state.collectedJudgments) this.state.collectedJudgments = {};
    this.state.collectedJudgments[webxdc.selfAddr] = this.localVotes || {};

    this.state.mode = "STATE_COLLECTING_VOTES";
    this.showForceAnnounceBtn = false;

    if (this.collectingTimer) clearTimeout(this.collectingTimer);
    this.collectingTimer = setTimeout(() => {
      if (this.state.mode === "STATE_COLLECTING_VOTES") {
        this.showForceAnnounceBtn = true;
        this.render();
      }
    }, 10000);

    const activePlayers = this.getActiveRoundPlayers();
    const allReceived = activePlayers.every(
      (p) => this.state.collectedJudgments[p.addr],
    );
    const isHost = this.getHostAddr() === webxdc.selfAddr;

    if (allReceived && isHost) {
      this.announceResults();
    } else {
      this.render();
    }
  }

  startLetterSelection() {
    const activeAddrs = this.state.players.map((p) => p.addr);
    this.state.activeRoundPlayers = activeAddrs;
    this.state.excludedPlayers = [];
    const isHost = this.getHostAddr() === webxdc.selfAddr;

    if (this.state.config.letterSelection === "random") {
      if (isHost) {
        const alphabet =
          currentLang === "fa"
            ? "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی"
            : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const selectedLetter =
          alphabet[Math.floor(Math.random() * alphabet.length)];
        this.state.currentLetter = selectedLetter;
        const startSummary = t("gameInProgress");
        const startTime = Date.now();
        webxdc.sendUpdate({
          payload: {
            type: "SET_LETTER",
            letter: selectedLetter,
            activePlayers: activeAddrs,
            startTime: startTime,
          },
          summary: startSummary,
          info: startSummary,
        });
      }
    } else {
      this.state.turnIdx = (this.state.round - 1) % this.state.players.length;
      this.state.currentLetter = "";
      this.state.inLetterSelection = true;
      this.saveState();
      this.render();
    }
  }

  startGameplay(startTime) {
    this.state.mode = "STATE_PLAYING";
    this.state.answers = {};
    this.state.stoppedBy = null;
    this.state.excludedPlayers = [];
    this.answersCollectionTimerStarted = false;
    this.showSkipMissingBtn = false;
    if (this.answersCollectionTimer) clearTimeout(this.answersCollectionTimer);

    const now = startTime || Date.now();
    this.state.roundStartTime = now;

    // Lock the Stop button for stopDelay seconds after the round starts
    if (this.state.config.enableStop && this.state.config.stopDelay > 0) {
      this.state.stopUnlockTime = now + this.state.config.stopDelay * 1000;
    } else {
      this.state.stopUnlockTime = null;
    }

    if (this.timerInterval) clearInterval(this.timerInterval);

    const elapsed = Math.floor((Date.now() - now) / 1000);
    if (this.state.config.timeLimit > 0) {
      if (elapsed >= this.state.config.timeLimit) {
        // Only alert for live restarts; the initial replay of a finished round
        // already shows the correct lobby state and needs no "expired" warning.
        if (this.initialReplayDone) alert(t("gameExpiredAlert"));
        this.state.mode = "STATE_LOBBY";
        this.saveState();
        this.render();
        return;
      }
    }
    this.timeLeft =
      this.state.config.timeLimit > 0
        ? Math.max(0, this.state.config.timeLimit - elapsed)
        : 0;

    this.timerInterval = setInterval(() => {
      if (this.state.config.timeLimit > 0) {
        this.timeLeft--;
        if (this.timeLeft <= 0) {
          clearInterval(this.timerInterval);
          this.submitMyAnswers(false);
        }
        const timerEl = document.getElementById("timer-display");
        if (timerEl) {
          timerEl.innerText = this.timeLeft.toString();
        }
      }
      this.updateStopButtonState();
    }, 1000);

    this.saveState();
    this.render();
  }

  // Keep the Stop button state in sync: delay lock and/or all-fields-filled condition
  updateStopButtonState() {
    const stopBtn = document.getElementById("btn-stop-game");
    if (!stopBtn) return;
    const c = this.state.config;
    if (!c.enableStop) return;

    const delayRemaining =
      c.stopDelay > 0 && this.state.stopUnlockTime
        ? Math.max(
          0,
          Math.ceil((this.state.stopUnlockTime - Date.now()) / 1000),
        )
        : 0;

    let disabled = false;
    if (delayRemaining > 0) {
      disabled = true;
      const delayNotice = document.getElementById("stop-delay-notice");
      if (delayNotice)
        delayNotice.innerText = t("stopDelayNotice").replace(
          "{sec}",
          delayRemaining,
        );
    } else if (c.stopConditionFull) {
      let allFilled = true;
      c.fields.forEach((_, idx) => {
        const val = (
          document.getElementById(`field-${idx}`)?.value || ""
        ).trim();
        if (!val) allFilled = false;
      });
      if (!allFilled) disabled = true;
    }

    if (disabled) {
      stopBtn.setAttribute("disabled", "true");
      stopBtn.className =
        "neo-btn bg-slate-300 text-slate-600 border-2 border-black shadow-[2px_2px_0px_#000] w-full font-black py-4 text-2xl tracking-widest my-2 uppercase cursor-not-allowed opacity-60";
    } else {
      stopBtn.removeAttribute("disabled");
      stopBtn.className =
        "neo-btn neo-btn-pink w-full font-black py-4 text-2xl tracking-widest my-2 uppercase";
    }

    const delayNotice = document.getElementById("stop-delay-notice");
    if (delayNotice) {
      if (delayRemaining > 0) delayNotice.classList.remove("hidden");
      else delayNotice.classList.add("hidden");
    }
    const fillNotice = document.getElementById("stop-notice");
    if (fillNotice) {
      if (disabled && delayRemaining <= 0)
        fillNotice.classList.remove("hidden");
      else fillNotice.classList.add("hidden");
    }
  }

  endGameplay(answers) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.state.stoppedBy) {
      this.state.answers[this.state.stoppedBy] = answers;
    }
    this.submitMyAnswers(false);
  }

  submitMyAnswers(isStopper) {
    if (this.state.answers[webxdc.selfAddr]) return;

    const myAnswers = {};
    this.state.config.fields.forEach((_, idx) => {
      const input = document.getElementById(`field-${idx}`);
      myAnswers[idx] = input ? input.value.trim() : "";
    });

    this.state.answers[webxdc.selfAddr] = myAnswers;

    if (isStopper) {
      webxdc.sendUpdate({
        payload: {
          type: "STOP_GAME",
          addr: webxdc.selfAddr,
          answers: myAnswers,
        },
        summary: `${webxdc.selfName} ${t("stop")}`,
        info: `${webxdc.selfName} ${t("stop")}`,
      });
    } else {
      webxdc.sendUpdate({
        payload: {
          type: "SUBMIT_ANSWERS",
          addr: webxdc.selfAddr,
          answers: myAnswers,
        },
        summary: `${webxdc.selfName} ${t("submittedAnswers")}`,
        info: `${webxdc.selfName} ${t("submittedAnswers")}`,
      });
    }

    this.checkAllAnswersSubmitted();
  }

  // --- Neobrutalism Header ---

  renderHeader() {
    const lightIcon = `<svg version="1.0" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="16" height="16" enable-background="new 0 0 64 64" xml:space="preserve" fill="#000000"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <g> <circle fill-rule="evenodd" clip-rule="evenodd" fill="#000000" cx="32.003" cy="32.005" r="16.001"></circle> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M12.001,31.997c0-2.211-1.789-4-4-4H4c-2.211,0-4,1.789-4,4 s1.789,4,4,4h4C10.212,35.997,12.001,34.208,12.001,31.997z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M12.204,46.139l-2.832,2.833c-1.563,1.562-1.563,4.094,0,5.656 c1.562,1.562,4.094,1.562,5.657,0l2.833-2.832c1.562-1.562,1.562-4.095,0-5.657C16.298,44.576,13.767,44.576,12.204,46.139z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M32.003,51.999c-2.211,0-4,1.789-4,4V60c0,2.211,1.789,4,4,4 s4-1.789,4-4l-0.004-4.001C36.003,53.788,34.21,51.999,32.003,51.999z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M51.798,46.143c-1.559-1.566-4.091-1.566-5.653-0.004 s-1.562,4.095,0,5.657l2.829,2.828c1.562,1.57,4.094,1.562,5.656,0s1.566-4.09,0-5.656L51.798,46.143z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M60.006,27.997l-4.009,0.008 c-2.203-0.008-3.992,1.781-3.992,3.992c-0.008,2.211,1.789,4,3.992,4h4.001c2.219,0.008,4-1.789,4-4 C64.002,29.79,62.217,27.997,60.006,27.997z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M51.798,17.859l2.828-2.829c1.574-1.566,1.562-4.094,0-5.657 c-1.559-1.567-4.09-1.567-5.652-0.004l-2.829,2.836c-1.562,1.555-1.562,4.086,0,5.649C47.699,19.426,50.239,19.418,51.798,17.859z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M32.003,11.995c2.207,0.016,4-1.789,4-3.992v-4 c0-2.219-1.789-4-4-4c-2.211-0.008-4,1.781-4,3.993l0.008,4.008C28.003,10.206,29.792,11.995,32.003,11.995z"></path> <path fill-rule="evenodd" clip-rule="evenodd" fill="#000000" d="M12.212,17.855c1.555,1.562,4.079,1.562,5.646-0.004 c1.574-1.551,1.566-4.09,0.008-5.649l-2.829-2.828c-1.57-1.571-4.094-1.559-5.657,0c-1.575,1.559-1.575,4.09-0.012,5.653 L12.212,17.855z"></path> </g> </g></svg>`;
    const darkIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M21.5287 15.9294C21.3687 15.6594 20.9187 15.2394 19.7987 15.4394C19.1787 15.5494 18.5487 15.5994 17.9187 15.5694C15.5887 15.4694 13.4787 14.3994 12.0087 12.7494C10.7087 11.2994 9.90873 9.40938 9.89873 7.36938C9.89873 6.22938 10.1187 5.12938 10.5687 4.08938C11.0087 3.07938 10.6987 2.54938 10.4787 2.32938C10.2487 2.09938 9.70873 1.77938 8.64873 2.21938C4.55873 3.93938 2.02873 8.03938 2.32873 12.4294C2.62873 16.5594 5.52873 20.0894 9.36873 21.4194C10.2887 21.7394 11.2587 21.9294 12.2587 21.9694C12.4187 21.9794 12.5787 21.9894 12.7387 21.9894C16.0887 21.9894 19.2287 20.4094 21.2087 17.7194C21.8787 16.7894 21.6987 16.1994 21.5287 15.9294Z" fill="#000000"></path> </g></svg>`;
    return `
            <header class="app-header">
                <div class="header-inner">
                    <div class="header-brand">
                        <h1>${t("gameTitle")}</h1>
                    </div>
                    
                    <div class="header-actions">
                        <!-- Theme Toggle Button -->
                        <button id="btn-theme-toggle" class="neo-btn neo-btn-cyan text-xs font-black px-2 py-1" title="${t("themeToggle")}">
                            ${currentTheme === "dark" ? lightIcon : darkIcon}
                            <span>${currentTheme === "dark" ? t("themeLight") : t("themeDark")}</span>
                        </button>
                        
                        <!-- Language Select Dropdown -->
                        <select id="select-lang" class="neo-select text-xs font-black py-1 bg-[#ff9f43] text-black">
                            <option value="fa" ${currentLang === "fa" ? "selected" : ""}>${t("langFa")}</option>
                            <option value="en" ${currentLang === "en" ? "selected" : ""}>${t("langEn")}</option>
                        </select>
                    </div>
                </div>
            </header>
        `;
  }

  render() {
    let content = "";
    let floatingBar = "";

    if (this.isMidGameJoiner()) {
      content = this.renderMidGameWaiting();
    } else {
      switch (this.state.mode) {
        case "STATE_CREATOR":
          content = this.renderCreator();
          break;
        case "STATE_LOBBY":
          const lobbyRes = this.renderLobby();
          content = typeof lobbyRes === "object" ? lobbyRes.content : lobbyRes;
          floatingBar =
            typeof lobbyRes === "object" ? lobbyRes.floatingBar || "" : "";
          break;
        case "STATE_PLAYING":
          content = this.renderPlaying();
          break;
        case "STATE_VOTING":
          content = this.renderVoting();
          break;
        case "STATE_COLLECTING_VOTES":
          content = this.renderCollectingVotes();
          break;
        case "STATE_SCORE":
          content = this.renderScore();
          break;
      }
    }

    const modalHtml = this.renderPlayerModal();

    this.root.className = "min-h-screen relative";
    this.root.innerHTML =
      this.renderHeader() + `<main>${content}</main>` + floatingBar + modalHtml;

    this.attachEvents();
  }

  renderMidGameWaiting() {
    const activePlayers = this.getActiveRoundPlayers();
    const activeNames = activePlayers.map((p) => p.name).join("، ");
    const phaseName =
      this.state.mode === "STATE_PLAYING"
        ? t("phasePlaying")
        : t("phaseVoting");

    return `
            <div class="neo-card p-5 my-4 text-center">
                <div class="mb-4">
                    <span class="neo-badge bg-[#ff5964] text-white px-3 py-1 text-xs font-black animate-pulse">
                        ${t("liveTag")} - ${t("midGameWaitingTitle")}
                    </span>
                </div>
                
                <div class="text-5xl mb-3 animate-bounce">⏳</div>
                
                <h2 class="text-2xl font-black mb-2">${t("midGameWaitingTitle")}</h2>
                
                <p class="text-sm font-bold text-muted mb-5 leading-relaxed">
                    ${t("midGameWaitingMsg")}
                </p>

                <div class="neo-card-sm p-4 text-start mb-4" style="background-color: var(--bg-card-alt)">
                    <div class="flex justify-between items-center mb-2 pb-2 border-b-2 border-black">
                        <span class="text-xs font-black uppercase text-muted">${t("letter")}:</span>
                        <span class="text-2xl font-black text-cyan">« ${this.state.currentLetter} »</span>
                    </div>
                    <div class="flex justify-between items-center mb-2 pb-2 border-b-2 border-black">
                        <span class="text-xs font-black uppercase text-muted">${t("currentPhaseLabel")}:</span>
                        <span class="text-sm font-black">${phaseName}</span>
                    </div>
                    <div>
                        <span class="block text-xs font-black uppercase text-muted mb-1">${t("activeRoundPlayersLabel")}:</span>
                        <span class="text-xs font-bold">${activeNames || "---"}</span>
                    </div>
                </div>

                <div class="neo-card-sm p-3 bg-[#ffe600] text-black font-black text-xs text-center border-2 border-black">
                    🔄 ${t("waitingRoundEnd")}
                </div>
            </div>
        `;
  }

  renderCreator() {
    const c = this.state.config;
    const noticeHtml = this.creatorNotice
      ? `
            <div class="neo-card-sm p-4 mb-4 bg-[#2ecc71] text-black border-3 border-black shadow-[4px_4px_0px_#000]">
                <div class="flex items-center gap-2 mb-1">
                    <span class="text-2xl">📦</span>
                    <h3 class="font-black text-base">${t("shareSuccessTitle")}</h3>
                </div>
                <p class="text-xs font-bold leading-relaxed">${this.creatorNotice.text}</p>
            </div>
        `
      : "";

    return `
            ${noticeHtml}
            <div class="neo-card p-5 mb-5">
                <div class="flex items-center justify-between mb-4 border-b-3 border-black pb-3">
                    <h2 class="text-xl font-black">${t("creatorMode")}</h2>
                </div>
                
                <div class="mb-4">
                    <label class="block text-xs font-black uppercase mb-1.5">${t("templates")}</label>
                    <select id="cfg-template" class="neo-input w-full p-2.5 font-bold cursor-pointer">
                        <option value="classic">${t("classicTemplate")}</option>
                        <option value="advanced">${t("advancedTemplate")}</option>
                        <option value="custom">${t("customTemplate")}</option>
                    </select>
                </div>
                
                <div class="mb-4">
                    <label class="block text-xs font-black uppercase mb-1.5">${t("fieldsLabel")}</label>
                    <textarea id="cfg-fields" rows="5" class="neo-input w-full p-3 font-bold">${c.fields.join("\n")}</textarea>
                </div>
                
                <div class="mb-4">
                    <label class="block text-xs font-black uppercase mb-1.5">${t("rulesLabel")}</label>
                    <textarea id="cfg-rules" rows="3" class="neo-input w-full p-3 font-bold">${c.rules || ""}</textarea>
                </div>
                
                <div class="mb-4">
                    <label class="block text-xs font-black uppercase mb-1.5">${t("letterSelection")}</label>
                    <select id="cfg-letter" class="neo-input w-full p-2.5 font-bold cursor-pointer">
                        <option value="random" ${c.letterSelection === "random" ? "selected" : ""}>${t("randomSelection")}</option>
                        <option value="manual" ${c.letterSelection === "manual" ? "selected" : ""}>${t("manualSelection")}</option>
                    </select>
                </div>

                <div class="mb-5">
                    <label class="block text-xs font-black uppercase mb-1.5">${t("votingModeLabel")}</label>
                    <select id="cfg-syncvoting" class="neo-input w-full p-2.5 font-bold cursor-pointer">
                        <option value="sync" ${c.syncVoting !== false ? "selected" : ""}>${t("votingModeSync")}</option>
                        <option value="async" ${c.syncVoting === false ? "selected" : ""}>${t("votingModeAsync")}</option>
                    </select>
                </div>
                
                <div class="neo-card-sm p-4 mb-5" style="background-color: var(--bg-card-alt)">
                    <h3 class="text-sm font-black uppercase border-b-2 border-black pb-2 mb-3">${t("gameEndSettings")}</h3>
                    
                    <div class="mb-3">
                        <label class="block text-xs font-bold mb-1">${t("timeLimit")}</label>
                        <input type="number" id="cfg-time" value="${c.timeLimit}" class="neo-input w-full p-2 font-bold">
                    </div>
                    
                    <div class="mb-3 flex items-center gap-2">
                        <input type="checkbox" id="cfg-enablestop" ${c.enableStop ? "checked" : ""} style="width:1.25rem; height:1.25rem; cursor:pointer">
                        <label for="cfg-enablestop" class="text-xs font-bold cursor-pointer">${t("enableStop")}</label>
                    </div>
                    
                    <div id="stop-settings" class="${c.enableStop ? "" : "hidden"}" style="padding-right:0.75rem; border-inline-start:3px solid var(--border-main); margin-top:0.5rem; padding-top:0.25rem">
                        <div class="mb-2">
                            <label class="block text-xs font-bold mb-1">${t("stopDelay")}</label>
                            <input type="number" id="cfg-stopdelay" value="${c.stopDelay}" class="neo-input w-full p-1.5 font-bold">
                        </div>
                        <div class="flex items-center gap-2">
                            <input type="checkbox" id="cfg-stopcond" ${c.stopConditionFull ? "checked" : ""} style="width:1rem; height:1rem; cursor:pointer">
                            <label for="cfg-stopcond" class="text-xs font-bold cursor-pointer">${t("stopCondition")}</label>
                        </div>
                    </div>
                </div>
                
                <button id="btn-share" class="neo-btn neo-btn-yellow w-full text-lg font-black py-4 px-4 uppercase tracking-wider">
                    ⚡ ${t("shareAndPlay")}
                </button>
            </div>
        `;
  }

  renderLobby() {
    const c = this.state.config;
    const hostAddr = this.getHostAddr();

    let playersHtml = this.state.players
      .map((p) => {
        const isMe = p.addr === webxdc.selfAddr;
        const isHostUser = p.addr === hostAddr;
        const votesArr =
          (this.state.kickVotes && this.state.kickVotes[p.addr]) || [];
        const totalOthers = Math.max(1, this.state.players.length - 1);
        const isVoted = votesArr.includes(webxdc.selfAddr);

        const kickVoteCount =
          votesArr.length > 0 ? ` (${votesArr.length}/${totalOthers})` : "";
        const kickBtn =
          !isMe && this.state.players.length >= 2
            ? `
                <button data-kick-addr="${p.addr}" class="btn-vote-kick neo-btn text-xs px-2.5 py-0.5 font-black rounded-full ${isVoted ? "neo-btn-kick-active" : "neo-btn-kick-inactive"}">
                    ${isVoted ? t("votedLabel") : "⚠️ " + t("voteKick")}${kickVoteCount}
                </button>
            `
            : "";

        return `
                <div class="neo-card-sm p-3.5 mb-2.5 flex flex-wrap justify-between items-center gap-2">
                    <div class="flex items-center gap-2">
                        <span class="font-black text-base ${isMe ? "text-cyan font-black" : ""}">
                            👤 ${p.name} ${isMe ? t("you") : ""}
                        </span>
                        ${isHostUser ? `<span class="neo-badge text-xs px-2 py-0.5 font-black bg-[#ffe600] text-black">👑 ${t("hostBadge")}</span>` : ""}
                        ${p.ready ? `<span class="neo-badge text-xs px-2.5 py-0.5 font-black bg-[#2ecc71] text-black">${t("ready")}</span>` : ""}
                    </div>
                    ${kickBtn}
                </div>
            `;
      })
      .join("");

    // Rule Box
    const hasRules = c.rules && c.rules.trim().length > 0;
    const rulesHtml = hasRules
      ? `
            <div class="bg-[#ffe600] text-black border-3 border-black rounded-2xl p-4 mb-5" style="box-shadow: 4px 4px 0px #000">
                <h3 class="font-black mb-1 text-sm uppercase">📜 ${t("rules")}:</h3>
                <p class="text-sm font-bold whitespace-pre-wrap">${c.rules}</p>
            </div>
        `
      : "";

    // Minimum players warning
    const isSinglePlayer = this.state.players.length < 2;
    const minPlayersNotice = isSinglePlayer
      ? `
            <div class="mb-4 p-3 bg-[#ff5964] text-white border-3 border-black rounded-xl text-center text-xs font-black" style="box-shadow: 3px 3px 0px #000">
                ${t("minPlayersWarning")}
            </div>
        `
      : "";

    let content = `
            ${rulesHtml}
            
            <div class="mb-2 flex justify-between items-center">
                <h3 class="font-black text-lg uppercase">🎮 ${t("players")} (${this.state.players.length})</h3>
            </div>
            
            ${minPlayersNotice}

            <div class="mb-5 pb-48">${playersHtml || '<p class="text-muted font-bold text-sm">' + t("waitingForOthers") + "</p>"}</div>
        `;

    const me = this.state.players.find((p) => p.addr === webxdc.selfAddr);
    const isReady = me?.ready;
    const isHostUser = webxdc.selfAddr === hostAddr;

    let floatingBar = "";

    const otherPlayers = this.state.players.filter((p) => p.addr !== hostAddr);
    const canHostStart =
      this.state.players.length >= 2 &&
      otherPlayers.length > 0 &&
      otherPlayers.every((p) => p.ready);

    if (
      this.state.inLetterSelection &&
      c.letterSelection === "manual" &&
      !this.state.currentLetter
    ) {
      const turnPlayer = this.state.players[this.state.turnIdx];
      if (turnPlayer && turnPlayer.addr === webxdc.selfAddr) {
        floatingBar = `
                    <div class="fixed-floating-lobby-bar">
                        <div style="max-width: 32rem; margin: 0 auto;">
                            <label class="block font-black text-lg mb-2 uppercase text-center">${t("chooseLetter")}</label>
                            <input type="text" id="manual-letter" maxlength="1" class="neo-input w-24 text-center text-4xl font-black p-2 mb-3 mx-auto block bg-white text-black uppercase">
                            <button id="btn-set-letter" class="neo-btn neo-btn-green w-full text-lg py-3 font-black">${t("start")}</button>
                        </div>
                    </div>
                `;
      } else if (turnPlayer) {
        floatingBar = `
                    <div class="fixed-floating-lobby-bar">
                        <div style="max-width: 32rem; margin: 0 auto;" class="text-center">
                            <div class="animate-pulse flex flex-col items-center">
                                <span class="text-3xl mb-1">⏳</span>
                                <span class="font-black text-sm">${t("waitingForLetter")} <b>${turnPlayer.name}</b>...</span>
                            </div>
                        </div>
                    </div>
                `;
      }
    } else if (isHostUser) {
      if (canHostStart) {
        floatingBar = `
                    <div class="fixed-floating-lobby-bar">
                        <div style="max-width: 32rem; margin: 0 auto;">
                            <button id="btn-host-start-game" class="neo-btn neo-btn-green w-full text-xl font-black py-4 uppercase tracking-wider shadow-[4px_4px_0px_#000]">
                                🚀 ${t("hostStartGame")}
                            </button>
                        </div>
                    </div>
                `;
      } else {
        floatingBar = `
                    <div class="fixed-floating-lobby-bar">
                        <div style="max-width: 32rem; margin: 0 auto;">
                            <div class="text-center font-black text-sm text-muted mb-2 flex items-center justify-center gap-1.5">
                                <span class="animate-spin text-base">⏳</span> ${isSinglePlayer ? t("minPlayersWarning") : t("waitingForOthersReady")}
                            </div>
                            <button disabled class="neo-btn bg-gray-400 text-black w-full text-xl font-black py-3.5 uppercase tracking-wider shadow-[4px_4px_0px_#000] cursor-not-allowed opacity-60">
                                🚀 ${t("hostStartGame")}
                            </button>
                        </div>
                    </div>
                `;
      }
    } else if (!isReady) {
      floatingBar = `
                <div class="fixed-floating-lobby-bar">
                    <div style="max-width: 32rem; margin: 0 auto;">
                        <button id="btn-ready" class="neo-btn neo-btn-green w-full text-xl font-black py-4 uppercase tracking-wider shadow-[4px_4px_0px_#000]">
                            👍 ${t("ready")}
                        </button>
                    </div>
                </div>
            `;
    } else {
      floatingBar = `
                <div class="fixed-floating-lobby-bar">
                    <div style="max-width: 32rem; margin: 0 auto;">
                        <div class="text-center font-black text-sm text-muted mb-2 flex items-center justify-center gap-1.5">
                            <span class="animate-spin text-base">⏳</span> ${t("waitingForHostToStart")}
                        </div>
                        <button id="btn-unready" class="neo-btn bg-[#ff5964] text-white w-full text-xl font-black py-3.5 uppercase tracking-wider shadow-[4px_4px_0px_#000]">
                            ❌ ${t("notReady")}
                        </button>
                    </div>
                </div>
            `;
    }

    return { content, floatingBar };
  }

  renderPlaying() {
    const c = this.state.config;

    if (this.state.answers[webxdc.selfAddr]) {
      const activePlayers = this.getActiveRoundPlayers();
      const submittedCount = activePlayers.filter(
        (p) => !!this.state.answers[p.addr],
      ).length;
      const isHost = this.getHostAddr() === webxdc.selfAddr;

      let skipBtnHtml = "";
      if (isHost && this.showSkipMissingBtn) {
        skipBtnHtml = `
                    <div class="mt-4 pt-4 border-t-2 border-black">
                        <p class="text-xs text-muted font-bold mb-2">${t("collectionPeriodEnded")}</p>
                        <button id="btn-skip-missing-answers" class="neo-btn neo-btn-pink w-full py-4 text-base font-black uppercase shadow-[3px_3px_0px_#000]">
                            ⏩ ${t("skipMissingAnswers")}
                        </button>
                    </div>
                `;
      }

      return `
                <div class="neo-card p-6 text-center my-6">
                    <div class="animate-spin text-5xl mb-4 inline-block">⏳</div>
                    <h2 class="text-xl font-black mb-3">${t("waitingForAnswersFromOthers")}</h2>
                    <div class="neo-badge bg-[#ffe600] text-black text-sm px-4 py-2 font-black inline-block mb-3 shadow-[2px_2px_0px_#000]">
                        📝 ${submittedCount} ${t("of")} ${activePlayers.length} ${t("playersUnit")}
                    </div>
                    <p class="text-xs text-muted font-bold">
                        ${this.showSkipMissingBtn ? t("collectionPeriodEnded") : t("collection10sTimer")}
                    </p>
                    ${skipBtnHtml}
                </div>
            `;
    }

    // BIGGER LETTER DISPLAY
    let headerHtml = `
            <div class="neo-card p-4 mb-4 flex justify-between items-center bg-[#ffe600] text-black">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-black uppercase tracking-wider">${t("letter")}:</span>
                    <span class="text-6xl font-black leading-none">${this.state.currentLetter}</span>
                </div>
                ${c.timeLimit > 0
        ? `
                    <div class="font-mono text-2xl font-black bg-[#ff5964] text-white border-2 border-black px-3.5 py-1.5 rounded-xl" style="box-shadow: 3px 3px 0px #000">
                        ⏱️ <span id="timer-display">${this.timeLeft}</span>s
                    </div>
                `
        : ""
      }
            </div>
        `;

    let isStopDisabled = false;
    if (c.stopConditionFull) {
      let allFilled = true;
      c.fields.forEach((_, idx) => {
        const el = document.getElementById(`field-${idx}`);
        if (!el || !el.value.trim()) {
          allFilled = false;
        }
      });
      if (!allFilled) isStopDisabled = true;
    }
    // Stop delay lock: keep the button disabled for stopDelay seconds after round start
    let stopDelayRemaining = 0;
    if (c.enableStop && c.stopDelay > 0 && this.state.stopUnlockTime) {
      stopDelayRemaining = Math.max(
        0,
        Math.ceil((this.state.stopUnlockTime - Date.now()) / 1000),
      );
      if (stopDelayRemaining > 0) isStopDisabled = true;
    }

    let stopNoticeHtml = "";
    if (stopDelayRemaining > 0) {
      stopNoticeHtml = `<p id="stop-delay-notice" class="text-xs text-center text-[#ff5964] font-black mb-3">🔒 ${t("stopDelayNotice").replace("{sec}", stopDelayRemaining)}</p>`;
    } else if (c.stopConditionFull && isStopDisabled) {
      stopNoticeHtml = `<p id="stop-notice" class="text-xs text-center text-[#ff5964] font-black mb-3">⚠️ ${t("fillAllFieldsNotice")}</p>`;
    }

    let stopBtn = c.enableStop
      ? `
            <button id="btn-stop-game" ${isStopDisabled ? "disabled" : ""} class="neo-btn ${isStopDisabled ? "bg-slate-300 text-slate-600 border-2 border-black" : "neo-btn-pink"} w-full font-black py-4 text-2xl tracking-widest my-2 uppercase">
                🛑 ${t("stop")}
            </button>
            ${stopNoticeHtml}
        `
      : "";

    let fieldsHtml = c.fields
      .map(
        (f, i) => `
            <div class="mb-4">
                <label class="block text-xs font-black uppercase mb-1.5">${f}</label>
                <input type="text" id="field-${i}" class="game-input neo-input w-full p-3 font-bold text-lg" autocomplete="off" placeholder="${f} ...">
            </div>
        `,
      )
      .join("");

    return `
            ${headerHtml}
            ${stopBtn}
            <div class="neo-card p-4 my-3">
                ${fieldsHtml}
                <div id="plastic-warning" class="hidden mt-3 p-3 bg-[#ff5964] text-white text-xs rounded-xl border-2 border-black font-black" style="box-shadow: 3px 3px 0px #000">
                    ${t("plasticWarning")}
                </div>
            </div>
        `;
  }

  renderVoting() {
    if (
      this.state.excludedPlayers &&
      this.state.excludedPlayers.includes(webxdc.selfAddr)
    ) {
      return `
                <div class="neo-card p-6 text-center my-6">
                    <div class="animate-pulse text-5xl mb-4">🛑</div>
                    <h2 class="text-xl font-black mb-3">${t("votingContinuedWithoutYouTitle")}</h2>
                    <p class="text-xs text-muted font-bold leading-relaxed mb-4">
                        ${t("votingContinuedWithoutYouMsg")}
                    </p>
                    <div class="neo-badge bg-[#ffe600] text-black text-xs px-4 py-2 font-black inline-block">
                        ⏳ ${t("waitingRoundEnd")}
                    </div>
                </div>
            `;
    }

    if (!this.localVotes) {
      this.localVotes = {};
      (this.state.config.fields || []).forEach((_, fIdx) => {
        this.localVotes[fIdx] = {};
      });
    }

    const isSync = this.state.config.syncVoting !== false;
    const activePlayers = this.getActiveRoundPlayers();
    const totalActive = activePlayers.length;
    const totalFields = this.state.config.fields.length;

    if (isSync) {
      // --- SYNCHRONOUS VOTING (Host controlled) ---
      const fIdx = this.state.currentFieldIdx;
      const fieldName = this.state.config.fields[fIdx];

      if (!this.state.fieldCompleted) this.state.fieldCompleted = {};
      const currentCompleted = this.state.fieldCompleted[fIdx] || {};
      const votedCount = activePlayers.filter(
        (p) => currentCompleted[p.addr],
      ).length;

      const progressText = `${votedCount} ${t("syncJudgedProgress").replace("{total}", totalActive)}`;
      const hasSubmittedThisField = !!currentCompleted[webxdc.selfAddr];

      let answersHtml = activePlayers
        .map((p) => {
          const rawAns = this.state.answers[p.addr]?.[fIdx];
          const isEmpty = !rawAns || !rawAns.trim();
          const displayAns = isEmpty ? t("emptyAnswer") : rawAns.trim();

          const myVote = this.localVotes?.[fIdx]?.[p.addr];
          const isMe = p.addr === webxdc.selfAddr;
          const isBtnDisabled = isEmpty || isMe || hasSubmittedThisField;

          return `
                    <div class="neo-card-sm p-4 mb-3 flex flex-col">
                        <div class="flex justify-between items-center mb-2 border-b-2 border-black pb-2">
                            <span class="text-xs font-bold text-muted">${p.name} ${isMe ? t("you") : ""}</span>
                            <span class="font-black text-lg ${isEmpty ? "text-[#ff5964] italic" : ""}">${displayAns}</span>
                        </div>
                        <div class="flex gap-2 mt-2">
                            <button ${isBtnDisabled ? "disabled" : ""} class="local-vote-btn neo-btn ${myVote === true ? "neo-btn-green" : ""} ${hasSubmittedThisField ? "opacity-50 cursor-not-allowed" : ""}" style="flex:1; padding:0.5rem; font-size:0.75rem" data-fidx="${fIdx}" data-target="${p.addr}" data-vote="true">
                                ${t("correct")}
                            </button>
                            <button ${isBtnDisabled ? "disabled" : ""} class="local-vote-btn neo-btn ${myVote === false ? "neo-btn-pink" : ""} ${hasSubmittedThisField ? "opacity-50 cursor-not-allowed" : ""}" style="flex:1; padding:0.5rem; font-size:0.75rem" data-fidx="${fIdx}" data-target="${p.addr}" data-vote="false">
                                ${t("wrong")}
                            </button>
                        </div>
                    </div>
                `;
        })
        .join("");

      const isHost = this.getHostAddr() === webxdc.selfAddr;
      const isLastField = fIdx === totalFields - 1;

      const counterHeader = `
                <div class="neo-badge bg-[#ffe600] text-black text-sm px-4 py-2 font-black inline-block mb-3 shadow-[2px_2px_0px_#000]">
                    📊 ${progressText}
                </div>
            `;

      let actionsHtml = "";
      if (isHost) {
        actionsHtml = `
                    <div class="mt-4 flex flex-col gap-2.5">
                        ${!hasSubmittedThisField
            ? `
                            <button id="btn-submit-field-votes" class="neo-btn neo-btn-green w-full text-base py-3.5 font-black uppercase shadow-[3px_3px_0px_#000]">
                                💾 ${t("submitScores")}
                            </button>
                        `
            : `
                            <button id="btn-submit-field-votes" class="neo-btn bg-[#2ecc71] text-black w-full text-base py-3.5 font-black uppercase shadow-[3px_3px_0px_#000]">
                                ✓ ${t("scoresSubmitted")}
                            </button>
                        `
          }
                        <button id="btn-next-field" class="neo-btn neo-btn-yellow w-full text-lg py-4 font-black uppercase shadow-[4px_4px_0px_#000]">
                            ➡️ ${isLastField ? t("finishVoting") : t("nextField")}
                        </button>
                    </div>
                `;
      } else {
        actionsHtml = `
                    <div class="mt-4 flex flex-col gap-2.5">
                        ${!hasSubmittedThisField
            ? `
                            <button id="btn-submit-field-votes" class="neo-btn neo-btn-green w-full text-lg py-4 font-black uppercase shadow-[4px_4px_0px_#000]">
                                💾 ${t("submitScores")}
                            </button>
                        `
            : `
                            <button id="btn-submit-field-votes" class="neo-btn bg-[#2ecc71] text-black w-full text-lg py-4 font-black uppercase shadow-[4px_4px_0px_#000]">
                                ✓ ${t("scoresSubmitted")}
                            </button>
                        `
          }
                    </div>
                `;
      }

      return `
                <div class="text-center mb-3">
                    <span class="neo-badge bg-[#00d2d3] text-black text-xs px-3 py-1 uppercase font-black">${t("voting")} (${fIdx + 1} / ${totalFields})</span>
                    <h2 class="text-3xl font-black mt-2 mb-2">${fieldName}</h2>
                    ${counterHeader}
                </div>
                ${answersHtml}
                ${actionsHtml}
            `;
    } else {
      // --- ASYNCHRONOUS VOTING (Independent / Self-Paced) ---
      if (
        this.localVotingFieldIdx === undefined ||
        this.localVotingFieldIdx === null
      ) {
        this.localVotingFieldIdx = 0;
      }
      const fIdx = Math.min(
        Math.max(0, this.localVotingFieldIdx),
        totalFields - 1,
      );
      const fieldName = this.state.config.fields[fIdx];

      const finishedMap = this.state.asyncFinishedVoters || {};
      const finishedCount = activePlayers.filter(
        (p) => finishedMap[p.addr],
      ).length;
      const isMeFinalized = !!finishedMap[webxdc.selfAddr];

      const progressText = `${finishedCount} ${t("of")} ${totalActive} ${t("asyncJudgingProgress")}`;

      let timerBox = "";
      if (this.state.votingCountdownEnd) {
        const remaining = Math.max(
          0,
          Math.ceil((this.state.votingCountdownEnd - Date.now()) / 1000),
        );
        timerBox = `
                    <div class="neo-card-sm p-3 mb-4 bg-[#ff5964] text-white border-2 border-black text-center shadow-[3px_3px_0px_#000] animate-pulse">
                        <div class="text-xs font-black uppercase mb-1">${t("votingCountdownTitle")}</div>
                        <div class="text-3xl font-black font-mono"><span id="voting-countdown-display">${remaining}</span>s</div>
                    </div>
                `;
      }

      let answersHtml = activePlayers
        .map((p) => {
          const rawAns = this.state.answers[p.addr]?.[fIdx];
          const isEmpty = !rawAns || !rawAns.trim();
          const displayAns = isEmpty ? t("emptyAnswer") : rawAns.trim();

          const myVote = this.localVotes?.[fIdx]?.[p.addr];
          const isMe = p.addr === webxdc.selfAddr;

          return `
                    <div class="neo-card-sm p-4 mb-3 flex flex-col">
                        <div class="flex justify-between items-center mb-2 border-b-2 border-black pb-2">
                            <span class="text-xs font-bold text-muted">${p.name} ${isMe ? t("you") : ""}</span>
                            <span class="font-black text-lg ${isEmpty ? "text-[#ff5964] italic" : ""}">${displayAns}</span>
                        </div>
                        <div class="flex gap-2 mt-2">
                            <button ${isEmpty || isMe || isMeFinalized ? "disabled" : ""} class="local-vote-btn neo-btn ${myVote === true ? "neo-btn-green" : ""}" style="flex:1; padding:0.5rem; font-size:0.75rem" data-fidx="${fIdx}" data-target="${p.addr}" data-vote="true">
                                ${t("correct")}
                            </button>
                            <button ${isEmpty || isMe || isMeFinalized ? "disabled" : ""} class="local-vote-btn neo-btn ${myVote === false ? "neo-btn-pink" : ""}" style="flex:1; padding:0.5rem; font-size:0.75rem" data-fidx="${fIdx}" data-target="${p.addr}" data-vote="false">
                                ${t("wrong")}
                            </button>
                        </div>
                    </div>
                `;
        })
        .join("");

      const isHost = this.getHostAddr() === webxdc.selfAddr;
      const isFirstField = fIdx === 0;
      const isLastField = fIdx === totalFields - 1;

      const counterHeader = `
                <div class="neo-badge bg-[#ffe600] text-black text-sm px-4 py-2 font-black inline-block mb-3 shadow-[2px_2px_0px_#000]">
                    📊 ${progressText}
                </div>
            `;

      let navButtons = `
                <div class="flex gap-2 mb-3">
                    <button id="btn-prev-local-field" ${isFirstField ? "disabled" : ""} class="neo-btn neo-btn-yellow flex-1 py-3 text-sm font-black uppercase shadow-[3px_3px_0px_#000] ${isFirstField ? "opacity-50 cursor-not-allowed" : ""}">
                        ⬅️ ${t("prevField")}
                    </button>
                    <button id="btn-next-local-field" ${isLastField ? "disabled" : ""} class="neo-btn neo-btn-yellow flex-1 py-3 text-sm font-black uppercase shadow-[3px_3px_0px_#000] ${isLastField ? "opacity-50 cursor-not-allowed" : ""}">
                        ➡️ ${t("nextField")}
                    </button>
                </div>
            `;

      let actionBtn = `
                <div class="mt-2 flex flex-col gap-2.5">
                    ${!isMeFinalized
          ? `
                        <button id="btn-finalize-voting" class="neo-btn neo-btn-green w-full text-lg py-4 font-black uppercase shadow-[4px_4px_0px_#000]">
                            💾 ${t("finalizeVoting")}
                        </button>
                    `
          : `
                        <button disabled class="neo-btn bg-[#2ecc71] text-black w-full text-lg py-4 font-black uppercase shadow-[4px_4px_0px_#000] cursor-not-allowed">
                            ✓ ${t("votingFinalized")}
                        </button>
                    `
        }
                    ${isHost && isLastField && !this.state.votingCountdownEnd
          ? `
                        <button id="btn-trigger-countdown" class="neo-btn neo-btn-pink w-full text-sm py-3 font-black uppercase shadow-[3px_3px_0px_#000]">
                            ⏱️ ${t("startCountdownBtn")}
                        </button>
                    `
          : ""
        }
                </div>
            `;

      return `
                <div class="text-center mb-3">
                    <span class="neo-badge bg-[#00d2d3] text-black text-xs px-3 py-1 uppercase font-black">${t("voting")} (${fIdx + 1} / ${totalFields})</span>
                    <h2 class="text-3xl font-black mt-2 mb-2">${fieldName}</h2>
                    ${counterHeader}
                </div>
                ${timerBox}
                ${navButtons}
                ${answersHtml}
                ${actionBtn}
            `;
    }
  }

  renderCollectingVotes() {
    const isHost = this.getHostAddr() === webxdc.selfAddr;
    const activePlayers = this.getActiveRoundPlayers();
    const collected = this.state.collectedJudgments || {};
    const receivedCount = activePlayers.filter((p) => collected[p.addr]).length;
    const totalActive = activePlayers.length;

    if (isHost) {
      const showBtn =
        this.showForceAnnounceBtn || receivedCount === totalActive;
      const announceBtn = showBtn
        ? `
                <button id="btn-force-announce" class="neo-btn neo-btn-green w-full text-lg py-4 font-black mt-4 uppercase">
                    📢 ${t("announceResults")}
                </button>
            `
        : "";

      return `
                <div class="neo-card p-6 text-center my-6">
                    <div class="animate-bounce text-5xl mb-4">⚖️</div>
                    <h2 class="text-2xl font-black mb-3">${t("collectingVotes")}</h2>
                    <div class="neo-badge bg-[#00d2d3] text-black text-sm px-4 py-2 font-black inline-block mb-4">
                        ${t("receivedJudgments")} ${receivedCount} ${t("of")} ${totalActive} ${t("playersUnit")}
                    </div>
                    <p class="text-xs text-muted font-bold mb-2">
                        ${this.showForceAnnounceBtn ? t("collectionPeriodEnded") : t("receivingJudgmentsMsg")}
                    </p>
                    ${announceBtn}
                </div>
            `;
    } else {
      return `
                <div class="neo-card p-6 text-center my-6">
                    <div class="animate-spin text-5xl mb-4 inline-block">⏳</div>
                    <h2 class="text-xl font-black mb-3">${t("waitingForCollection")}</h2>
                    <p class="text-xs text-muted font-bold">
                        ${t("votesSentWaitingAnnouncement")}
                    </p>
                </div>
            `;
    }
  }

  announceResults() {
    if (this.state.mode !== "STATE_COLLECTING_VOTES") return;
    if (this.collectingTimer) clearTimeout(this.collectingTimer);

    const activePlayers = this.getActiveRoundPlayers();
    const fields = this.state.config.fields || [];
    const collected = this.state.collectedJudgments || {};

    const finalVotes = {};

    fields.forEach((_, fIdx) => {
      finalVotes[fIdx] = {};
      activePlayers.forEach((p) => {
        const ans = this.state.answers[p.addr]?.[fIdx] || "";
        if (!ans.trim()) {
          finalVotes[fIdx][p.addr] = false;
          return;
        }

        let yesCount = 0;
        let totalCount = 0;

        Object.entries(collected).forEach(([voterAddr, playerJudgments]) => {
          if (voterAddr === p.addr) return;
          const vote = playerJudgments?.[fIdx]?.[p.addr];
          if (vote !== undefined) {
            totalCount++;
            if (vote === true) yesCount++;
          }
        });

        if (totalCount === 0) {
          finalVotes[fIdx][p.addr] = true;
        } else {
          finalVotes[fIdx][p.addr] = yesCount / totalCount >= 0.5;
        }
      });
    });

    // Deep-copy scores so we never mutate the shared state object
    const scores = {};
    Object.entries(this.state.scores || {}).forEach(([addr, sc]) => {
      scores[addr] = { total: sc.total || 0, thisRound: sc.thisRound || 0 };
    });
    this.state.players.forEach((p) => {
      if (!scores[p.addr]) scores[p.addr] = { total: 0, thisRound: 0 };
      scores[p.addr].thisRound = 0;
    });

    fields.forEach((_, fIdx) => {
      const validAnswers = {};
      activePlayers.forEach((p) => {
        const ans = this.state.answers[p.addr]?.[fIdx] || "";
        const isApproved = finalVotes[fIdx]?.[p.addr];
        if (ans.trim().length > 0 && isApproved) {
          validAnswers[p.addr] = ans.trim().toLowerCase();
        }
      });

      const answerCounts = {};
      Object.values(validAnswers).forEach((ans) => {
        answerCounts[ans] = (answerCounts[ans] || 0) + 1;
      });

      Object.entries(validAnswers).forEach(([addr, ans]) => {
        const pts = answerCounts[ans] > 1 ? 5 : 10;
        if (scores[addr]) {
          scores[addr].thisRound += pts;
          scores[addr].total += pts;
        }
      });
    });

    const gameEndedText = t("gameEnded");
    webxdc.sendUpdate(
      {
        payload: {
          type: "FINISH_VOTING",
          finalVotes,
          scores,
        },
        summary: gameEndedText,
        info: gameEndedText,
      },
      gameEndedText,
    );
  }

  renderScore() {
    const sortedPlayers = [...this.state.players].sort((a, b) => {
      const scoreA = this.state.scores[a.addr]?.total || 0;
      const scoreB = this.state.scores[b.addr]?.total || 0;
      return scoreB - scoreA;
    });

    let scoreRows = sortedPlayers
      .map((p, idx) => {
        const sc = this.state.scores[p.addr] || { total: 0, thisRound: 0 };
        return `
                <tr class="player-inspect-row ${p.addr === webxdc.selfAddr ? "is-me" : ""}" data-addr="${p.addr}">
                    <td class="text-xs font-black">#${idx + 1}</td>
                    <td class="font-black text-sm">
                        ${p.name} ${p.addr === webxdc.selfAddr ? t("you") : ""}
                        <span style="display:block; font-size:10px; color:var(--neo-cyan); font-weight:700">🔍 ${t("playerDetails")}</span>
                    </td>
                    <td class="text-center text-[#2ecc71] font-black text-base">+${sc.thisRound}</td>
                    <td class="text-center font-black text-lg">${sc.total}</td>
                </tr>
            `;
      })
      .join("");

    const me = this.state.players.find((p) => p.addr === webxdc.selfAddr);

    return `
            <div class="text-center mb-4">
                <span class="neo-badge bg-[#ffe600] text-black px-4 py-1 text-sm">${t("round")} ${this.state.round}</span>
                <h2 class="text-2xl font-black mt-1 uppercase">🏆 ${t("scoreboard")}</h2>
            </div>
            
            <div class="scoreboard-table-container">
                <table class="scoreboard-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>${t("players")}</th>
                            <th class="text-center">${t("thisRound")}</th>
                            <th class="text-center">${t("totalScore")}</th>
                        </tr>
                    </thead>
                    <tbody class="font-bold">
                        ${scoreRows}
                    </tbody>
                </table>
            </div>
            
            <div class="mt-4">
                <button id="btn-play-again" class="neo-btn neo-btn-green w-full text-lg font-black py-4 uppercase tracking-wider shadow-[4px_4px_0px_#000]">
                    🔄 ${t("goToNextRound")}
                </button>
            </div>
        `;
  }

  // Modal showing player's detailed answers for the round
  renderPlayerModal() {
    if (!this.activeModalPlayer) return "";

    const player = this.state.players.find(
      (p) => p.addr === this.activeModalPlayer,
    );
    if (!player) return "";

    const playerAnswers = this.state.answers[player.addr] || {};
    const fields = this.state.config.fields || [];

    let rowsHtml = fields
      .map((field, idx) => {
        const ans = playerAnswers[idx] || "";
        const isApproved = this.state.finalVotes?.[idx]?.[player.addr];
        const hasAns = ans && ans.trim().length > 0;

        return `
                <div class="neo-card-sm p-3 flex justify-between items-center">
                    <div>
                        <span class="block text-xs font-black uppercase text-muted">${field}</span>
                        <span class="font-black text-sm ${hasAns ? "" : "text-[#ff5964] italic"}">
                            ${hasAns ? ans : t("emptyAnswer")}
                        </span>
                    </div>
                    <div>
                        <span class="neo-badge text-xs px-2.5 py-0.5 font-black ${isApproved ? "bg-[#2ecc71] text-black" : "bg-[#ff5964] text-white"}">
                            ${isApproved ? t("approved") : t("rejected")}
                        </span>
                    </div>
                </div>
            `;
      })
      .join("");

    return `
            <div id="modal-overlay">
                <div class="modal-dialog">
                    <div class="modal-header">
                        <h3 class="font-black text-lg">
                            📝 ${t("playerDetails")}: <span class="text-cyan">${player.name}</span>
                        </h3>
                        <button id="btn-close-modal" class="neo-btn bg-[#ff5964] text-white text-xs px-2 py-1 font-black">✕</button>
                    </div>
                    
                    <div class="modal-body">
                        ${rowsHtml}
                    </div>
                    
                    <button id="btn-close-modal-footer" class="neo-btn neo-btn-yellow w-full text-base font-black py-2.5 uppercase">
                        ${t("close")}
                    </button>
                </div>
            </div>
        `;
  }

  // --- Attach Event Listeners ---
  attachEvents() {
    // Theme Toggle Event
    document
      .getElementById("btn-theme-toggle")
      ?.addEventListener("click", () => {
        currentTheme = currentTheme === "light" ? "dark" : "light";
        localStorage.setItem("esmfamil_theme", currentTheme);
        this.applyTheme();
        this.render();
      });

    // Language Switch Event
    document.getElementById("select-lang")?.addEventListener("change", (e) => {
      currentLang = e.target.value;
      localStorage.setItem("esmfamil_lang", currentLang);
      this.applyTheme();
      this.render();
    });

    // Modal Close Events
    document
      .getElementById("btn-close-modal")
      ?.addEventListener("click", () => {
        this.activeModalPlayer = null;
        this.render();
      });
    document
      .getElementById("btn-close-modal-footer")
      ?.addEventListener("click", () => {
        this.activeModalPlayer = null;
        this.render();
      });
    document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "modal-overlay") {
        this.activeModalPlayer = null;
        this.render();
      }
    });

    // State: CREATOR
    if (this.state.mode === "STATE_CREATOR") {
      document
        .getElementById("cfg-template")
        ?.addEventListener("change", (e) => {
          const val = e.target.value;
          const ta = document.getElementById("cfg-fields");
          if (!ta) return;
          if (val === "classic") {
            ta.value = t("classicFieldsList");
          } else if (val === "advanced") {
            ta.value = t("advancedFieldsList");
          } else if (val === "custom") {
            ta.value = "";
          }
        });

      document
        .getElementById("cfg-enablestop")
        ?.addEventListener("change", (e) => {
          const isChecked = e.target.checked;
          const settings = document.getElementById("stop-settings");
          if (isChecked) settings?.classList.remove("hidden");
          else settings?.classList.add("hidden");
        });

      document
        .getElementById("btn-share")
        ?.addEventListener("click", async () => {
          const fieldsVal = document.getElementById("cfg-fields")?.value || "";
          const fields = fieldsVal
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s);
          if (fields.length === 0) return alert(t("atLeastOneField"));

          this.state.creatorAddr = webxdc.selfAddr;
          this.state.config = {
            fields: fields,
            rules: (document.getElementById("cfg-rules")?.value || "").trim(),
            letterSelection:
              document.getElementById("cfg-letter")?.value || "random",
            timeLimit:
              parseInt(document.getElementById("cfg-time")?.value) || 0,
            enableStop: document.getElementById("cfg-enablestop")?.checked,
            stopDelay:
              parseInt(document.getElementById("cfg-stopdelay")?.value) || 0,
            stopConditionFull: document.getElementById("cfg-stopcond")?.checked,
            syncVoting:
              (document.getElementById("cfg-syncvoting")?.value || "sync") ===
              "sync",
          };

          const shareBtn = document.getElementById("btn-share");
          if (shareBtn) {
            shareBtn.setAttribute("disabled", "true");
            shareBtn.innerHTML = "⏳ " + t("compressingAndSending");
          }

          try {
            const { base64Data } = await createXdcZip({
              ...this.state.config,
              creatorAddr: webxdc.selfAddr,
            });

            await webxdc.sendToChat({
              file: {
                name: "esmfamil.xdc",
                base64: base64Data,
              },
              text: t("newGameCreated"),
            });

            this.creatorNotice = {
              type: "success",
              text: t("shareSuccessMsg"),
            };
          } catch (err) {
            console.error("Error creating XDC zip:", err);
            await webxdc.sendToChat({
              text: `${t("buildError")}: ${err.message}`,
            });
            this.creatorNotice = {
              type: "error",
              text: `${t("errorLabel")}: ${err.message}`,
            };
          }

          this.saveState();
          this.render();
        });
    }

    // State: LOBBY
    if (this.state.mode === "STATE_LOBBY") {
      document
        .getElementById("btn-host-start-game")
        ?.addEventListener("click", () => {
          const hostAddr = this.getHostAddr();
          if (webxdc.selfAddr !== hostAddr) return;

          const otherPlayers = this.state.players.filter(
            (p) => p.addr !== hostAddr,
          );
          const canHostStart =
            this.state.players.length >= 2 &&
            otherPlayers.length > 0 &&
            otherPlayers.every((p) => p.ready);
          if (!canHostStart) return;

          const hostP = this.state.players.find(
            (p) => p.addr === webxdc.selfAddr,
          );
          if (hostP) hostP.ready = true;

          const activeAddrs = this.state.players.map((p) => p.addr);

          if (this.state.config.letterSelection === "random") {
            const alphabet =
              currentLang === "fa"
                ? "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی"
                : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            const selectedLetter =
              alphabet[Math.floor(Math.random() * alphabet.length)];
            const startSummary = t("gameInProgress");
            const startTime = Date.now();
            webxdc.sendUpdate({
              payload: {
                type: "SET_LETTER",
                letter: selectedLetter,
                activePlayers: activeAddrs,
                hostAddr: webxdc.selfAddr,
                startTime: startTime,
              },
              summary: startSummary,
              info: startSummary,
            });
          } else {
            const startTime = Date.now();
            webxdc.sendUpdate({
              payload: {
                type: "START_GAME",
                hostAddr: webxdc.selfAddr,
                activePlayers: activeAddrs,
                startTime: startTime,
              },
            });
          }
        });

      document.getElementById("btn-ready")?.addEventListener("click", () => {
        webxdc.sendUpdate({
          payload: { type: "READY", addr: webxdc.selfAddr },
        });
      });

      document.getElementById("btn-unready")?.addEventListener("click", () => {
        webxdc.sendUpdate({
          payload: { type: "UNREADY", addr: webxdc.selfAddr },
        });
      });

      document.querySelectorAll(".btn-vote-kick").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const targetAddr = e.currentTarget.getAttribute("data-kick-addr");
          if (!targetAddr) return;

          if (!this.state.kickVotes) this.state.kickVotes = {};
          if (!this.state.kickVotes[targetAddr])
            this.state.kickVotes[targetAddr] = [];
          const votesArr = this.state.kickVotes[targetAddr];
          const idx = votesArr.indexOf(webxdc.selfAddr);
          if (idx > -1) {
            votesArr.splice(idx, 1);
          } else {
            votesArr.push(webxdc.selfAddr);
          }

          const totalPlayers = this.state.players.length;
          const otherPlayersCount = totalPlayers - 1;
          if (
            otherPlayersCount > 0 &&
            votesArr.length / otherPlayersCount >= 0.5
          ) {
            this.state.players = this.state.players.filter(
              (p) => p.addr !== targetAddr,
            );
            delete this.state.kickVotes[targetAddr];
          }

          this.saveState();
          this.render();

          webxdc.sendUpdate({
            payload: {
              type: "VOTE_KICK",
              voterAddr: webxdc.selfAddr,
              targetAddr: targetAddr,
            },
          });
        });
      });

      document
        .getElementById("btn-set-letter")
        ?.addEventListener("click", () => {
          const letter = (
            document.getElementById("manual-letter")?.value || ""
          ).trim();
          if (!letter) return;
          const activeAddrs = this.state.players.map((p) => p.addr);
          this.state.activeRoundPlayers = activeAddrs;
          const startSummary = t("gameInProgress");
          const startTime = Date.now();
          webxdc.sendUpdate({
            payload: {
              type: "SET_LETTER",
              letter: letter,
              activePlayers: activeAddrs,
              startTime: startTime,
            },
            summary: startSummary,
            info: startSummary,
          });
        });
    }

    // State: PLAYING
    if (this.state.mode === "STATE_PLAYING") {
      document
        .getElementById("btn-skip-missing-answers")
        ?.addEventListener("click", () => {
          const activePlayers = this.getActiveRoundPlayers();
          const submittedAddrs = activePlayers
            .filter((p) => !!this.state.answers[p.addr])
            .map((p) => p.addr);
          const missingAddrs = activePlayers
            .filter((p) => !this.state.answers[p.addr])
            .map((p) => p.addr);

          webxdc.sendUpdate({
            payload: {
              type: "SKIP_MISSING_ANSWERS",
              activeVotingPlayers: submittedAddrs,
              missingPlayers: missingAddrs,
            },
          });
        });

      const stopBtn = document.getElementById("btn-stop-game");
      if (stopBtn) {
        stopBtn.addEventListener("click", () => {
          // Stop is still locked by the delay
          if (
            this.state.config.enableStop &&
            this.state.config.stopDelay > 0 &&
            this.state.stopUnlockTime &&
            Date.now() < this.state.stopUnlockTime
          ) {
            return;
          }
          if (this.state.config.stopConditionFull) {
            let allFilled = true;
            this.state.config.fields.forEach((_, idx) => {
              const val = (
                document.getElementById(`field-${idx}`)?.value || ""
              ).trim();
              if (!val) allFilled = false;
            });
            if (!allFilled) {
              alert(t("fillAllFields"));
              return;
            }
          }

          this.submitMyAnswers(true);
        });
      }

      // Real-time checking of input completion to enable/disable Stop button
      const inputs = document.querySelectorAll(".game-input");
      inputs.forEach((input) => {
        input.addEventListener("input", () => {
          // Check Plastic warning
          const warning = document.getElementById("plastic-warning");
          let showWarning = false;
          inputs.forEach((i) => {
            if (
              i.value.includes("پلاستیکی") ||
              i.value.toLowerCase().includes("plastic")
            ) {
              showWarning = true;
            }
          });
          if (showWarning) warning?.classList.remove("hidden");
          else warning?.classList.add("hidden");

          // Check Stop conditions dynamically (delay lock + all-fields-filled)
          this.updateStopButtonState();
        });
      });

      // Sync the initial stop-button state (e.g. remaining delay lock)
      this.updateStopButtonState();
    }

    // State: VOTING
    if (this.state.mode === "STATE_VOTING") {
      const localVoteBtns = document.querySelectorAll(".local-vote-btn");
      localVoteBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const targetBtn = e.target.closest(".local-vote-btn");
          if (!targetBtn || targetBtn.hasAttribute("disabled")) return;

          const targetAddr = targetBtn.getAttribute("data-target");
          const vote = targetBtn.getAttribute("data-vote") === "true";
          const btnFIdx = parseInt(targetBtn.getAttribute("data-fidx"));
          const fIdx = !isNaN(btnFIdx)
            ? btnFIdx
            : this.state.config.syncVoting !== false
              ? this.state.currentFieldIdx
              : this.localVotingFieldIdx || 0;

          const isSync = this.state.config.syncVoting !== false;
          const currentCompleted = this.state.fieldCompleted?.[fIdx] || {};
          if (isSync && currentCompleted[webxdc.selfAddr]) return;

          if (!this.localVotes) this.localVotes = {};
          if (!this.localVotes[fIdx]) this.localVotes[fIdx] = {};
          this.localVotes[fIdx][targetAddr] = vote;
          this.render();
        });
      });

      document
        .getElementById("btn-submit-field-votes")
        ?.addEventListener("click", () => {
          const fIdx = this.state.currentFieldIdx;
          if (!this.state.fieldCompleted) this.state.fieldCompleted = {};
          if (!this.state.fieldCompleted[fIdx])
            this.state.fieldCompleted[fIdx] = {};
          this.state.fieldCompleted[fIdx][webxdc.selfAddr] = true;

          webxdc.sendUpdate({
            payload: {
              type: "FIELD_VOTE_DONE",
              addr: webxdc.selfAddr,
              fIdx: fIdx,
            },
          });

          this.render();
        });

      document
        .getElementById("btn-next-field")
        ?.addEventListener("click", () => {
          const isLastField =
            this.state.currentFieldIdx >= this.state.config.fields.length - 1;
          if (isLastField) {
            const collectingText = t("collectingVotes");
            webxdc.sendUpdate({
              payload: { type: "SUBMIT_JUDGMENTS_START" },
              summary: collectingText,
              info: collectingText,
            });
          } else {
            webxdc.sendUpdate({ payload: { type: "NEXT_FIELD" } });
          }
        });

      document
        .getElementById("btn-prev-local-field")
        ?.addEventListener("click", () => {
          if ((this.localVotingFieldIdx || 0) > 0) {
            this.localVotingFieldIdx = (this.localVotingFieldIdx || 0) - 1;
            this.render();
          }
        });

      document
        .getElementById("btn-next-local-field")
        ?.addEventListener("click", () => {
          const totalFields = this.state.config.fields.length;
          if ((this.localVotingFieldIdx || 0) < totalFields - 1) {
            this.localVotingFieldIdx = (this.localVotingFieldIdx || 0) + 1;
            this.render();
          }
        });

      document
        .getElementById("btn-finalize-voting")
        ?.addEventListener("click", () => {
          if (!this.state.asyncFinishedVoters)
            this.state.asyncFinishedVoters = {};
          this.state.asyncFinishedVoters[webxdc.selfAddr] = true;

          webxdc.sendUpdate({
            payload: {
              type: "FINALIZE_ASYNC_VOTING",
              addr: webxdc.selfAddr,
              localVotes: this.localVotes || {},
            },
          });

          const activePlayers = this.getActiveRoundPlayers();
          const finishedCount = activePlayers.filter(
            (p) => this.state.asyncFinishedVoters[p.addr],
          ).length;
          const halfCount = Math.ceil(activePlayers.length / 2);

          if (finishedCount >= halfCount && !this.state.votingCountdownEnd) {
            const endTime = Date.now() + 20000;
            this.state.votingCountdownEnd = endTime;
            this.startVotingCountdown();
            if (this.getHostAddr() === webxdc.selfAddr) {
              webxdc.sendUpdate({
                payload: { type: "START_VOTING_COUNTDOWN", endTime: endTime },
              });
            }
          }

          if (finishedCount >= activePlayers.length) {
            this.startCollectingJudgments();
          } else {
            this.render();
          }
        });

      document
        .getElementById("btn-trigger-countdown")
        ?.addEventListener("click", () => {
          if (!this.state.votingCountdownEnd) {
            const endTime = Date.now() + 20000;
            this.state.votingCountdownEnd = endTime;
            this.startVotingCountdown();
            webxdc.sendUpdate({
              payload: { type: "START_VOTING_COUNTDOWN", endTime: endTime },
            });
            this.render();
          }
        });
    }

    // State: COLLECTING_VOTES
    if (this.state.mode === "STATE_COLLECTING_VOTES") {
      document
        .getElementById("btn-force-announce")
        ?.addEventListener("click", () => {
          this.announceResults();
        });
    }

    // State: SCORE
    if (this.state.mode === "STATE_SCORE") {
      document
        .getElementById("btn-play-again")
        ?.addEventListener("click", () => {
          this.state.mode = "STATE_LOBBY";
          this.state.players.forEach((p) => (p.ready = false));
          this.state.activeRoundPlayers = [];
          this.state.answers = {};
          this.state.stoppedBy = null;
          this.saveState();
          this.render();
        });

      // Player Row click to open answer inspector modal
      const rows = document.querySelectorAll(".player-inspect-row");
      rows.forEach((row) => {
        row.addEventListener("click", (e) => {
          const addr = row.getAttribute("data-addr");
          if (addr) {
            this.activeModalPlayer = addr;
            this.render();
          }
        });
      });
    }
  }
}

// Initialize application on DOM load
window.addEventListener("DOMContentLoaded", () => {
  window.app = new GameApp();
});
