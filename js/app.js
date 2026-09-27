(() => {
  "use strict";

  const KEYS = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };
  const KEY_LABELS = ["D", "F", "J", "K"];
  const LANE_FILL = ["#c27655", "#5d8a86", "#c9a15b", "#6d6a74"];
  const WINDOWS = [
    { name: "PERFECT", window: 0.045, score: 300 },
    { name: "GREAT", window: 0.09, score: 200 },
    { name: "GOOD", window: 0.14, score: 100 },
  ];
  const APPROACH = 1.55;
  const HIT_Z = 0;

  const els = {
    menu: document.getElementById("menu"),
    game: document.getElementById("game"),
    list: document.getElementById("song-list"),
    hint: document.getElementById("library-hint"),
    skillBtn: document.getElementById("btn-skill"),
    skillSrc: document.getElementById("skill-md"),
    uploadBtn: document.getElementById("btn-upload"),
    zipInput: document.getElementById("zip-input"),
    canvas: document.getElementById("stage"),
    title: document.getElementById("hud-title"),
    artist: document.getElementById("hud-artist"),
    score: document.getElementById("hud-score"),
    acc: document.getElementById("hud-acc"),
    judge: document.getElementById("judge"),
    combo: document.getElementById("combo"),
    pauseLayer: document.getElementById("pause-layer"),
    resultLayer: document.getElementById("result-layer"),
  };

  const ctx2d = els.canvas.getContext("2d");
  let songs = [];
  let raf = 0;
  let state = null;

  function show(view) {
    els.menu.classList.toggle("is-on", view === "menu");
    els.game.classList.toggle("is-on", view === "game");
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = els.canvas.clientWidth;
    const h = els.canvas.clientHeight;
    els.canvas.width = Math.floor(w * dpr);
    els.canvas.height = Math.floor(h * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const DB_NAME = "monument-rhythm";
  const STORE = "songs";
  const SEED = ["ivory-steps", "sand-procession"];

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const q = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      q.onsuccess = () => resolve(q.result || []);
      q.onerror = () => reject(q.error);
    });
  }

  async function idbPut(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function recordToSong(row) {
    return {
      id: row.id,
      title: row.title,
      artist: row.artist,
      duration: row.duration,
      bpm: row.bpm,
      difficulty: row.difficulty,
      notes: row.notes,
      chartData: row.chart,
      audioBlob: row.audioBlob,
    };
  }

  async function refreshLibrary() {
    const rows = await idbAll();
    rows.sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh"));
    songs = rows.map(recordToSong);
    renderList();
    els.hint.textContent = songs.length
      ? `本机已保存 ${songs.length} 首。上传新的 zip 会追加或覆盖同名曲目。`
      : "本地曲库为空。请上传 Skill 生成的歌曲 zip。";
  }

  async function seedDemos() {
    const existing = await idbAll();
    const have = new Set(existing.map((r) => r.id));
    for (const id of SEED) {
      if (have.has(id)) continue;
      try {
        const chartRes = await fetch(`songs/${id}/chart.json`);
        if (!chartRes.ok) continue;
        const chart = await chartRes.json();
        const audioName = chart.audio || "audio.mp3";
        const audioRes = await fetch(`songs/${id}/${audioName}`);
        if (!audioRes.ok) continue;
        const audioBlob = await audioRes.blob();
        await idbPut(makeRecord(id, chart, audioBlob, audioName));
      } catch {
        /* file:// 或资源缺失时跳过，不影响上传曲库 */
      }
    }
  }

  function makeRecord(id, chart, audioBlob, audioName) {
    return {
      id,
      title: chart.title || id,
      artist: chart.artist || "",
      duration: chart.duration || 0,
      bpm: chart.bpm || 0,
      difficulty: chart.difficulty || "normal",
      notes: (chart.notes || []).length,
      chart,
      audioBlob,
      audioName: audioName || "audio.mp3",
      addedAt: Date.now(),
    };
  }

  function isAudioName(name) {
    return /\.(mp3|ogg|oga|wav|m4a|aac|flac)$/i.test(name);
  }

  async function importZip(file) {
    if (typeof JSZip === "undefined") {
      els.hint.textContent = "缺少 JSZip，无法解压。";
      return;
    }
    els.hint.textContent = "正在读取曲包…";
    const zip = await JSZip.loadAsync(file);
    const groups = new Map();
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const clean = path.replace(/\\/g, "/");
      if (clean.indexOf("__MACOSX/") !== -1) return;
      const parts = clean.split("/").filter(Boolean);
      const filename = parts.pop();
      const folder = parts.length ? parts[parts.length - 1] : "_root";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push({ filename, entry });
    });
    let saved = 0;
    for (const [folder, files] of groups) {
      const chartEntry = files.find((f) => f.filename.toLowerCase() === "chart.json");
      const audioEntry = files.find((f) => isAudioName(f.filename));
      if (!chartEntry || !audioEntry) continue;
      let chart;
      try {
        chart = JSON.parse(await chartEntry.entry.async("string"));
      } catch {
        continue;
      }
      const audioBlob = await audioEntry.entry.async("blob");
      const id = folder === "_root" ? (chart.title || file.name.replace(/\.zip$/i, "")) : folder;
      const slug = String(id).toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "") || "song";
      await idbPut(makeRecord(slug, chart, audioBlob, audioEntry.filename));
      saved += 1;
    }
    await refreshLibrary();
    els.hint.textContent = saved
      ? `已保存 ${saved} 首到本机。之后打开本页无需再传。`
      : "压缩包里没有可用曲目（每个文件夹需含音频与 chart.json）。";
  }

  async function loadLibrary() {
    try {
      await seedDemos();
      await refreshLibrary();
    } catch (err) {
      els.hint.textContent = "本机存储不可用。仍可上传曲包尝试游玩（本次关闭后不会保留）。";
    }
  }

  function renderList() {
    els.list.innerHTML = "";
    if (!songs.length) {
      const empty = document.createElement("li");
      empty.innerHTML = '<span class="title">尚无曲目</span><span class="meta">请上传曲包 zip</span>';
      empty.style.cursor = "default";
      els.list.appendChild(empty);
      return;
    }
    songs.forEach((song, i) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.innerHTML = `
        <span class="title">${escapeHtml(song.title)}</span>
        <span class="stat">${song.difficulty || "normal"} · ${song.notes || "—"} notes</span>
        <span class="meta">${escapeHtml(song.artist || "Unknown")} · ${fmtTime(song.duration)} · ${Math.round(song.bpm || 0)} BPM</span>
        <button type="button" class="ghost del" data-del="${escapeHtml(song.id)}">删除</button>
      `;
      li.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        startSong(i);
      });
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") startSong(i);
      });
      const del = li.querySelector("[data-del]");
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await idbDelete(song.id);
        await refreshLibrary();
      });
      els.list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function compileNotes(chart) {
    const offset = Number(chart.offset) || 0;
    const lanes = chart.lanes || 4;
    const notes = (chart.notes || [])
      .map((n) => ({
        t: Number(n.t) + offset,
        lane: Math.max(0, Math.min(lanes - 1, Number(n.lane) || 0)),
        type: n.type === "hold" ? "hold" : "tap",
        end: n.type === "hold" ? Number(n.end) + offset : null,
        hit: false,
        released: false,
        missed: false,
        holdActive: false,
      }))
      .filter((n) => Number.isFinite(n.t))
      .sort((a, b) => a.t - b.t || a.lane - b.lane);
    return { lanes, notes, duration: Number(chart.duration) || (notes.at(-1)?.t || 0) + 2 };
  }

  async function startSong(index) {
    const song = songs[index];
    if (!song) return;
    stopLoop();
    stopAudio();
    const chart = song.chartData;
    if (!chart) {
      els.hint.textContent = "这首曲子没有谱面数据。";
      return;
    }
    const compiled = compileNotes(chart);
    const player = new Audio();
    player.preload = "auto";
    if (song.audioBlob) player.src = URL.createObjectURL(song.audioBlob);
    else if (song.audioUrl) player.src = song.audioUrl;
    else {
      els.hint.textContent = "没有可播放的音频。";
      return;
    }
    player.addEventListener("ended", () => {
      if (state && state.playing && !state.finished) finishSong();
    });
    try {
      await player.play();
    } catch (err) {
      els.hint.textContent = "音频无法播放。";
      return;
    }
    state = {
      songIndex: index,
      song,
      chart,
      ...compiled,
      player,
      playing: true,
      pausedAt: 0,
      keys: [false, false, false, false],
      stats: { score: 0, combo: 0, maxCombo: 0, pf: 0, gr: 0, gd: 0, ms: 0, judged: 0 },
      lastJudge: "",
      finished: false,
    };
    els.title.textContent = chart.title || song.title;
    els.artist.textContent = chart.artist || song.artist || "";
    els.pauseLayer.classList.remove("is-on");
    els.resultLayer.classList.remove("is-on");
    updateHud();
    show("game");
    resize();
    loop();
  }

  function nowTime() {
    if (!state) return 0;
    if (!state.playing) return state.pausedAt;
    return state.player ? state.player.currentTime : 0;
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function stopAudio() {
    if (!state || !state.player) return;
    try {
      state.player.pause();
      state.player.src = "";
    } catch {
      /* ignore */
    }
  }

  function pauseGame() {
    if (!state || !state.playing || state.finished) return;
    state.playing = false;
    state.pausedAt = nowTime();
    if (state.player) state.player.pause();
    els.pauseLayer.classList.add("is-on");
  }

  async function resumeGame() {
    if (!state || state.playing || state.finished) return;
    els.pauseLayer.classList.remove("is-on");
    try {
      await state.player.play();
    } catch {
      /* ignore */
    }
    state.playing = true;
    loop();
  }

  function quitToMenu() {
    stopLoop();
    stopAudio();
    state = null;
    els.pauseLayer.classList.remove("is-on");
    els.resultLayer.classList.remove("is-on");
    show("menu");
  }

  function judgeHit(note, dt) {
    const adt = Math.abs(dt);
    for (const w of WINDOWS) {
      if (adt <= w.window) return w;
    }
    return null;
  }

  function applyJudge(name, score, isMiss) {
    const st = state.stats;
    if (isMiss) {
      st.ms += 1;
      st.combo = 0;
      state.lastJudge = "MISS";
    } else {
      st.score += score + Math.min(st.combo, 80) * 2;
      st.combo += 1;
      st.maxCombo = Math.max(st.maxCombo, st.combo);
      if (name === "PERFECT") st.pf += 1;
      else if (name === "GREAT") st.gr += 1;
      else st.gd += 1;
      state.lastJudge = name;
    }
    st.judged += 1;
    flashJudge(state.lastJudge);
    updateHud();
  }

  function flashJudge(text) {
    els.judge.textContent = text;
    els.judge.classList.remove("is-in");
    void els.judge.offsetWidth;
    els.judge.classList.add("is-in");
    els.combo.textContent = state.stats.combo > 1 ? String(state.stats.combo) : "";
    els.combo.classList.toggle("is-on", state.stats.combo > 1);
  }

  function updateHud() {
    if (!state) return;
    els.score.textContent = String(state.stats.score).padStart(6, "0");
    const st = state.stats;
    const denom = st.judged || 1;
    const acc = ((st.pf * 1 + st.gr * 0.8 + st.gd * 0.4) / denom) * 100;
    els.acc.textContent = `${acc.toFixed(1)}%`;
  }

  function press(lane, down) {
    if (!state || !state.playing || state.finished) return;
    const was = state.keys[lane];
    state.keys[lane] = down;
    const t = nowTime();
    if (down && !was) {
      let best = null;
      let bestDt = 1;
      for (const n of state.notes) {
        if (n.lane !== lane || n.hit || n.missed) continue;
        const dt = t - n.t;
        if (Math.abs(dt) < Math.abs(bestDt) && Math.abs(dt) <= 0.16) {
          best = n;
          bestDt = dt;
        }
      }
      if (best) {
        const grade = judgeHit(best, bestDt);
        if (grade) {
          best.hit = true;
          if (best.type === "hold") best.holdActive = true;
          applyJudge(grade.name, grade.score, false);
        }
      }
    }
    if (!down && was) {
      for (const n of state.notes) {
        if (n.lane !== lane || n.type !== "hold" || !n.holdActive || n.released || n.missed) continue;
        n.holdActive = false;
        n.released = true;
        const grade = judgeHit({ t: n.end }, t - n.end);
        if (grade) applyJudge(grade.name, grade.score, false);
        else applyJudge("MISS", 0, true);
      }
    }
  }

  function scanMisses(t) {
    for (const n of state.notes) {
      if (n.missed || n.hit) {
        if (n.type === "hold" && n.hit && !n.released && !n.missed && t > n.end + 0.16) {
          if (!state.keys[n.lane]) {
            n.released = true;
            n.missed = true;
            applyJudge("MISS", 0, true);
          } else {
            n.released = true;
            applyJudge("PERFECT", 300, false);
          }
        }
        continue;
      }
      if (t - n.t > 0.16) {
        n.missed = true;
        applyJudge("MISS", 0, true);
      }
    }
  }

  function finishSong() {
    if (!state || state.finished) return;
    state.finished = true;
    state.playing = false;
    stopLoop();
    const st = state.stats;
    const total = Math.max(1, state.notes.reduce((n, x) => n + (x.type === "hold" ? 2 : 1), 0));
    const acc = ((st.pf * 1 + st.gr * 0.8 + st.gd * 0.4) / Math.max(1, st.judged)) * 100;
    let grade = "C";
    if (acc >= 96 && st.ms === 0) grade = "S";
    else if (acc >= 90) grade = "A";
    else if (acc >= 80) grade = "B";
    document.getElementById("result-grade").textContent = grade;
    document.getElementById("result-title").textContent = state.chart.title || "完成";
    document.getElementById("r-score").textContent = String(st.score);
    document.getElementById("r-acc").textContent = `${acc.toFixed(1)}%`;
    document.getElementById("r-combo").textContent = String(st.maxCombo);
    document.getElementById("r-pf").textContent = String(st.pf);
    document.getElementById("r-gr").textContent = String(st.gr);
    document.getElementById("r-gd").textContent = String(st.gd);
    document.getElementById("r-ms").textContent = String(st.ms);
    void total;
    els.resultLayer.classList.add("is-on");
  }

  function project(lane, z, w, h, lanes) {
    const horizonY = h * 0.18;
    const hitY = h * 0.66;
    const clamped = Math.max(-0.15, Math.min(1.15, z));
    const ease = Math.pow(Math.max(0, clamped), 1.12);
    const y = hitY - (hitY - horizonY) * ease;
    const nearW = w * 0.78;
    const farW = w * 0.16;
    const road = farW + (nearW - farW) * (1 - ease);
    const x0 = (w - road) / 2;
    const laneW = road / lanes;
    return {
      x: x0 + lane * laneW,
      y,
      w: laneW,
      road,
      x0,
      ease,
    };
  }

  function drawFrame() {
    const w = els.canvas.clientWidth;
    const h = els.canvas.clientHeight;
    const g = ctx2d;
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#d7e3e6");
    sky.addColorStop(0.42, "#e8d6b8");
    sky.addColorStop(1, "#c9a882");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // distant monument
    g.save();
    g.translate(w * 0.5, h * 0.12);
    g.fillStyle = "rgba(139, 112, 86, 0.28)";
    g.beginPath();
    g.moveTo(0, -46);
    g.lineTo(22, -18);
    g.lineTo(16, 38);
    g.lineTo(-16, 38);
    g.lineTo(-22, -18);
    g.closePath();
    g.fill();
    g.restore();

    const lanes = state ? state.lanes : 4;
    const t = state ? nowTime() : 0;
    const near = project(0, 0, w, h, lanes);
    const far = project(0, 1, w, h, lanes);

    // road slab
    g.beginPath();
    g.moveTo(far.x0, far.y);
    g.lineTo(far.x0 + far.road, far.y);
    g.lineTo(near.x0 + near.road, near.y);
    g.lineTo(near.x0, near.y);
    g.closePath();
    g.fillStyle = "#d8c0a0";
    g.fill();

    for (let i = 0; i <= lanes; i += 1) {
      const a = project(i, 1, w, h, lanes);
      const b = project(i, 0, w, h, lanes);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokeStyle = i === 0 || i === lanes ? "rgba(59,47,39,0.28)" : "rgba(59,47,39,0.12)";
      g.lineWidth = i === 0 || i === lanes ? 2 : 1;
      g.stroke();
    }

    // hit ledge
    g.fillStyle = "#f4efe6";
    g.fillRect(near.x0 - 6, near.y - 5, near.road + 12, 10);
    g.fillStyle = "rgba(59,47,39,0.18)";
    g.fillRect(near.x0 - 6, near.y + 5, near.road + 12, 7);

    // keys
    for (let i = 0; i < lanes; i += 1) {
      const p = project(i, 0, w, h, lanes);
      const pressed = state && state.keys[i];
      g.fillStyle = pressed ? LANE_FILL[i % LANE_FILL.length] : "rgba(244,239,230,0.72)";
      const kw = p.w * 0.72;
      const kx = p.x + (p.w - kw) / 2;
      const ky = near.y + 16;
      roundRect(g, kx, ky, kw, 26, 3);
      g.fill();
      g.fillStyle = "rgba(59,47,39,0.45)";
      g.font = "11px Avenir Next, PingFang SC, sans-serif";
      g.textAlign = "center";
      g.fillText(KEY_LABELS[i] || String(i + 1), kx + kw / 2, ky + 17);
    }

    if (state) {
      for (const n of state.notes) {
        if (n.missed && n.type !== "hold") continue;
        const remain = n.t - t;
        const z = remain / APPROACH;
        if (z > 1.05) continue;
        if (n.type === "hold") {
          const zEnd = (n.end - t) / APPROACH;
          drawHold(g, n, z, zEnd, w, h, lanes);
        }
        if (!n.hit || n.type === "hold") {
          if (z < -0.12 && n.hit) continue;
          drawTap(g, n, Math.max(-0.08, z), w, h, lanes, n.hit);
        }
      }
    }

    // ground shade
    const shade = g.createLinearGradient(0, h * 0.82, 0, h);
    shade.addColorStop(0, "rgba(139,112,86,0)");
    shade.addColorStop(1, "rgba(139,112,86,0.25)");
    g.fillStyle = shade;
    g.fillRect(0, h * 0.82, w, h * 0.18);
  }

  function drawTap(g, note, z, w, h, lanes, ghost) {
    const p = project(note.lane, z, w, h, lanes);
    const nw = p.w * 0.7;
    const nh = 12 + (1 - p.ease) * 10;
    const x = p.x + (p.w - nw) / 2;
    const y = p.y - nh * 0.55;
    g.globalAlpha = ghost ? 0.28 : 1;
    g.fillStyle = LANE_FILL[note.lane % LANE_FILL.length];
    roundRect(g, x, y, nw, nh, 2);
    g.fill();
    g.globalAlpha = 1;
  }

  function drawHold(g, note, z0, z1, w, h, lanes) {
    const a = project(note.lane, Math.max(-0.05, Math.min(1, z0)), w, h, lanes);
    const b = project(note.lane, Math.max(-0.05, Math.min(1, z1)), w, h, lanes);
    const color = LANE_FILL[note.lane % LANE_FILL.length];
    g.strokeStyle = color;
    g.globalAlpha = note.holdActive ? 0.9 : 0.4;
    g.lineWidth = Math.max(6, a.w * 0.18);
    g.beginPath();
    g.moveTo(a.x + a.w / 2, a.y);
    g.lineTo(b.x + b.w / 2, b.y);
    g.stroke();
    g.globalAlpha = 1;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function loop() {
    if (!state) return;
    const t = nowTime();
    if (state.playing) scanMisses(t);
    drawFrame();
    const audioDur = (state.player && state.player.duration) || state.duration;
    if (state.playing && t >= audioDur + 0.4) {
      finishSong();
      return;
    }
    raf = requestAnimationFrame(loop);
  }

  window.addEventListener("resize", () => {
    resize();
    drawFrame();
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "Escape") {
      if (els.resultLayer.classList.contains("is-on")) quitToMenu();
      else if (state && state.playing) pauseGame();
      else if (els.pauseLayer.classList.contains("is-on")) resumeGame();
      return;
    }
    if (e.code in KEYS) {
      e.preventDefault();
      press(KEYS[e.code], true);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code in KEYS) press(KEYS[e.code], false);
  });

  els.canvas.addEventListener("pointerdown", (e) => {
    if (!state) return;
    const rect = els.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const h = rect.height;
    const near = project(0, 0, w, h, state.lanes);
    if (x < near.x0 || x > near.x0 + near.road) return;
    const lane = Math.min(state.lanes - 1, Math.max(0, Math.floor(((x - near.x0) / near.road) * state.lanes)));
    press(lane, true);
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      press(lane, false);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointerup", up);
  });

  document.getElementById("btn-pause").addEventListener("click", pauseGame);
  document.getElementById("btn-resume").addEventListener("click", resumeGame);
  document.getElementById("btn-retry").addEventListener("click", () => {
    if (state) startSong(state.songIndex, true);
  });
  document.getElementById("btn-again").addEventListener("click", () => {
    if (state) startSong(state.songIndex, true);
  });
  document.getElementById("btn-quit").addEventListener("click", quitToMenu);
  document.getElementById("btn-back").addEventListener("click", quitToMenu);

  function downloadSkillMd() {
    const text = (els.skillSrc && els.skillSrc.value) || "";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "SKILL.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  els.skillBtn.addEventListener("click", downloadSkillMd);
  els.uploadBtn.addEventListener("click", () => els.zipInput.click());
  els.zipInput.addEventListener("change", async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    try {
      await importZip(file);
    } catch (err) {
      els.hint.textContent = "曲包无法读取，请确认是 Skill 生成的 zip。";
    }
  });

  const pointerLanes = new Map();
  document.querySelectorAll("#pads .pad").forEach((pad) => {
    const lane = Number(pad.dataset.lane);
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      pointerLanes.set(e.pointerId, lane);
      pad.classList.add("is-down");
      try { pad.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      press(lane, true);
    };
    const up = (e) => {
      e.preventDefault();
      const held = pointerLanes.get(e.pointerId);
      pointerLanes.delete(e.pointerId);
      pad.classList.remove("is-down");
      if (held === lane) press(lane, false);
    };
    pad.addEventListener("pointerdown", down);
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", up);
    pad.addEventListener("lostpointercapture", up);
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  resize();
  loadLibrary();
  drawFrame();
})();
