// ============================================================
//  משחק משפחתי אינטראקטיבי - שרת ראשי
//  מאת: אמיר כהן
// ============================================================
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3007;

// --- נתיבים ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// --- גיבוי DB ל-GitHub (persistence ששורד restart ב-Render) ---
const GH = {
  token: process.env.GH_TOKEN || '',
  owner: process.env.GH_OWNER || '',
  repo: process.env.GH_REPO || '',
  branch: process.env.GH_BRANCH || 'main',
  path: process.env.GH_PATH || 'db.json'
};
const GH_ENABLED = !!(GH.token && GH.owner && GH.repo);
let ghSha = null; // ה-sha הנוכחי של הקובץ ב-GitHub (לעדכונים)

// קריאת db.json מ-GitHub. מחזיר את התוכן (string) או null אם לא קיים/כבוי.
async function ghPull() {
  if (!GH_ENABLED) return null;
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(GH.path)}?ref=${encodeURIComponent(GH.branch)}`;
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GH.token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'family-game' }
    });
    if (r.status === 404) { ghSha = null; return null; }   // עוד לא קיים - גיבוי ראשון יוצר אותו
    if (!r.ok) { console.warn('ghPull failed:', r.status); return null; }
    const data = await r.json();
    ghSha = data.sha;
    return Buffer.from(data.content || '', 'base64').toString('utf8');
  } catch (e) {
    console.warn('ghPull error:', e.message);
    return null;
  }
}

// דחיפת db.json ל-GitHub עם טיפול בהתנגשות 409 (sha לא מעודכן)
async function ghPush(retry = true) {
  if (!GH_ENABLED) return;
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(GH.path)}`;
  const body = {
    message: `update db.json ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(db, null, 2), 'utf8').toString('base64'),
    branch: GH.branch
  };
  if (ghSha) body.sha = ghSha;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GH.token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'family-game', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (r.status === 409 && retry) {
      // התנגשות sha - משוך את ה-sha העדכני ונסה שוב פעם אחת
      await ghPull();
      return ghPush(false);
    }
    if (!r.ok) { console.warn('ghPush failed:', r.status); return; }
    const data = await r.json();
    if (data.content && data.content.sha) ghSha = data.content.sha;
  } catch (e) {
    console.warn('ghPush error:', e.message);
  }
}

// --- משתמשי מנהל ---
// מנהל-על: קבוע, לא ניתן לשינוי
const SUPER_USER = 'amirco';
const SUPER_PASS = 'Havefun360';
// מנהל משני: ברירת מחדל, ניתן לשינוי דרך הדשבורד (נשמר ב-db)
const DEFAULT_SECONDARY = { user: 'Fun360', pass: '123456789' };

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// --- בסיס נתונים (JSON פשוט) ---
function defaultDB() {
  const stations = [];
  for (let i = 1; i <= 10; i++) {
    stations.push({
      id: i,
      title: `תחנה ${i}`,
      questionType: 'text',     // 'text' | 'photo'
      questionText: '',
      imageUrl: '',             // תמונה מצורפת לשאלה (אופציונלי)
      correctAnswer: '',        // לתשובת טקסט - מילות מפתח מופרדות בפסיק
      points: 10
    });
  }
  return {
    gameName: 'המשחק המשפחתי',
    stations,
    players: {},   // playerId -> {id, name, team, joinedAt, floor, answers:{}}
    submissions: [], // לוג מלא של כל ההגשות
    secondaryUser: { ...DEFAULT_SECONDARY }, // מנהל משני (ניתן לשינוי)
    speedBonus: {
      enabled: true,
      maxBonus: 10,        // בונוס מקסימלי לתשובה מיידית
      windowSec: 60        // אחרי כמה שניות הבונוס מתאפס ל-0
    }
  };
}

let db;
async function loadDB() {
  let loaded = false;
  // 1. נסה למשוך מ-GitHub (מקור האמת אם מוגדר)
  const remote = await ghPull();
  if (remote) {
    try {
      db = JSON.parse(remote);
      if (db.stations && db.stations.length) {
        loaded = true;
        // שמור עותק מקומי לגיבוי מהיר
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
        console.log('📥 DB נטען מ-GitHub');
      }
    } catch (e) { console.warn('GitHub DB parse failed, נופל לדיסק מקומי'); }
  }
  // 2. נפילה לדיסק מקומי
  if (!loaded) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db.stations || db.stations.length === 0) db = defaultDB();
    } catch (e) {
      db = defaultDB();
    }
  }
  // backfill לשדות חדשים אם נטען DB ישן
  if (!db.secondaryUser) db.secondaryUser = { ...DEFAULT_SECONDARY };
  if (!db.speedBonus) db.speedBonus = { enabled: true, maxBonus: 10, windowSec: 60 };
}

let saveTimer = null;
let ghPushTimer = null;
function saveDB() {
  // שמירה מקומית מיידית (debounce קצר כמו קודם)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
  }, 200);
  // דחיפה ל-GitHub עם debounce ארוך יותר (~4 שניות) כדי לא להציף את ה-API
  if (GH_ENABLED) {
    clearTimeout(ghPushTimer);
    ghPushTimer = setTimeout(() => { ghPush(); }, 4000);
  }
}

// --- העלאת קבצים ---
// תשובות משתמשים (תמונות) - נשמרות לדיסק כרגיל (לא מוטמעות ב-db כדי לא לנפח אותו)
const storage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, UPLOADS_DIR),
  filename: (req, f, cb) => {
    const ext = path.extname(f.originalname) || '.jpg';
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 } });

// תמונות שאלה שהמנהל מעלה - נשמרות בזיכרון ומוטמעות כ-data URI בתוך db.json
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// --- SSE: עדכוני זמן-אמת ללוח הסטטיסטיקות ---
let sseClients = [];
function broadcast() {
  const payload = `data: ${JSON.stringify(buildLeaderboard())}\n\n`;
  sseClients.forEach(c => { try { c.write(payload); } catch (e) {} });
}
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify(buildLeaderboard())}\n\n`);
  sseClients.push(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ============================================================
//  לוגיקת ניקוד וטבלת תוצאות
// ============================================================
function checkAnswer(station, answerText) {
  if (station.questionType === 'photo') return null; // תשובת תמונה - אין בדיקה אוטומטית
  if (!station.correctAnswer) return null;
  const keys = station.correctAnswer.split(',').map(s => normalize(s)).filter(Boolean);
  const ans = normalize(answerText);
  return keys.some(k => ans.includes(k) || k.includes(ans));
}
function normalize(s) {
  return (s || '').toString().trim().toLowerCase()
    .replace(/[\s.,!?'"״׳-]/g, '');
}

// בונוס מהירות: יורד לינארית מ-maxBonus (תשובה מיידית) ל-0 (אחרי windowSec)
function speedBonus(timeMs) {
  const cfg = db.speedBonus || {};
  if (!cfg.enabled) return 0;
  const sec = (timeMs || 0) / 1000;
  if (sec >= cfg.windowSec) return 0;
  const ratio = 1 - (sec / cfg.windowSec);
  return Math.round(cfg.maxBonus * ratio);
}

function buildLeaderboard() {
  const stationCount = db.stations.length;
  const players = Object.values(db.players).map(p => {
    const answers = Object.values(p.answers || {});
    const correct = answers.filter(a => a.correct === true).length;
    const pending = answers.filter(a => a.correct === null).length; // תמונות שמחכות לאישור
    const totalTime = answers.reduce((s, a) => s + (a.timeMs || 0), 0);
    const basePoints = answers.reduce((s, a) => s + (a.correct ? (a.basePoints || 0) : 0), 0);
    const bonusPoints = answers.reduce((s, a) => s + (a.correct ? (a.bonus || 0) : 0), 0);
    const points = basePoints + bonusPoints;
    const avgTime = answers.length ? Math.round(totalTime / answers.length / 1000) : 0;
    return {
      id: p.id, name: p.name, team: p.team,
      floor: correct,             // קומות = תשובות נכונות
      correct, pending,
      answered: answers.length,
      points, basePoints, bonusPoints,
      totalTimeSec: Math.round(totalTime / 1000),
      avgTimeSec: avgTime,
      stationCount
    };
  });

  // דירוג: קודם נקודות, אז מהירות
  players.sort((a, b) => b.points - a.points || a.totalTimeSec - b.totalTimeSec);

  // פרסים מיוחדים
  const awards = {};
  if (players.length) {
    const fastest = [...players].filter(p => p.answered > 0)
      .sort((a, b) => a.avgTimeSec - b.avgTimeSec)[0];
    if (fastest) awards.fastest = fastest.name;
    const mostCorrect = [...players].sort((a, b) => b.correct - a.correct)[0];
    if (mostCorrect && mostCorrect.correct > 0) awards.mostCorrect = mostCorrect.name;
  }

  // ניקוד מהיר לכל תחנה (מי ענה נכון הכי מהר בכל תחנה)
  const stationSpeed = {};
  db.stations.forEach(st => {
    let best = null;
    Object.values(db.players).forEach(p => {
      const a = (p.answers || {})[st.id];
      if (a && a.correct === true) {
        if (!best || a.timeMs < best.timeMs) best = { name: p.name, timeMs: a.timeMs };
      }
    });
    if (best) stationSpeed[st.id] = best;
  });

  return {
    gameName: db.gameName,
    players,
    awards,
    stationSpeed,
    stationCount,
    teams: groupByTeam(players)
  };
}
function groupByTeam(players) {
  const map = {};
  players.forEach(p => {
    const t = p.team || 'ללא קבוצה';
    if (!map[t]) map[t] = { team: t, points: 0, correct: 0, members: 0 };
    map[t].points += p.points;
    map[t].correct += p.correct;
    map[t].members++;
  });
  return Object.values(map).sort((a, b) => b.points - a.points);
}

// ============================================================
//  API למתחרים
// ============================================================
// רשימת קבוצות פעילות (לבחירה במסך ההצטרפות)
app.get('/api/teams', (req, res) => {
  const teams = [...new Set(
    Object.values(db.players)
      .map(p => (p.team || '').trim())
      .filter(Boolean)
  )].sort();
  res.json({ teams });
});

// הצטרפות / זיהוי שחקן
app.post('/api/join', (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const team = (req.body.team || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'נדרש שם' });
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.players[id] = { id, name, team, joinedAt: Date.now(), answers: {} };
  saveDB(); broadcast();
  res.json({ playerId: id, name, team });
});

// קבלת פרטי תחנה (לשאלה)
app.get('/api/station/:id', (req, res) => {
  const st = db.stations.find(s => s.id == req.params.id);
  if (!st) return res.status(404).json({ error: 'תחנה לא קיימת' });
  const pid = req.query.player;
  const player = pid ? db.players[pid] : null;
  const already = player && player.answers[st.id] ? player.answers[st.id] : null;
  res.json({
    id: st.id, title: st.title, questionType: st.questionType,
    questionText: st.questionText, imageUrl: st.imageUrl, points: st.points,
    gameName: db.gameName,
    alreadyAnswered: !!already,
    previousResult: already ? { correct: already.correct, pending: already.correct === null } : null
  });
});

// הגשת תשובה (טקסט או תמונה)
app.post('/api/answer', upload.single('photo'), (req, res) => {
  const { playerId, stationId, answerText, startedAt } = req.body;
  const player = db.players[playerId];
  const station = db.stations.find(s => s.id == stationId);
  if (!player || !station) return res.status(400).json({ error: 'נתונים לא תקינים' });

  const timeMs = startedAt ? Math.max(0, Date.now() - Number(startedAt)) : 0;
  let correct = null;
  let photoUrl = '';

  if (req.file) {
    photoUrl = '/uploads/' + req.file.filename;
  }
  if (station.questionType === 'text') {
    correct = checkAnswer(station, answerText);
  } // אם תמונה - correct נשאר null עד אישור מנהל

  // חישוב בונוס מהירות (רק לתשובה נכונה ידועה; לתמונה - יחושב באישור)
  const bonus = correct === true ? speedBonus(timeMs) : 0;

  player.answers[station.id] = {
    stationId: station.id,
    answerText: answerText || '',
    photoUrl,
    correct,
    basePoints: correct ? station.points : 0,
    bonus,
    points: correct ? (station.points + bonus) : 0,
    timeMs,
    at: Date.now()
  };
  db.submissions.push({ playerId, name: player.name, team: player.team, ...player.answers[station.id] });
  saveDB(); broadcast();
  res.json({
    correct,
    pending: correct === null,
    points: correct ? station.points : 0,
    bonus,
    message: correct === true
      ? (bonus > 0 ? `תשובה נכונה! +${station.points} נק' ועוד ${bonus} בונוס מהירות! ⚡🎉` : 'תשובה נכונה! 🎉')
      : correct === false ? 'לא מדויק, אבל ממשיכים! 💪'
      : 'התקבל! המנהל יבדוק 📸'
  });
});

// טבלת תוצאות (לפולינג גיבוי)
app.get('/api/leaderboard', (req, res) => res.json(buildLeaderboard()));

// ============================================================
//  אימות מנהל - שתי רמות (מנהל-על קבוע + מנהל משני ניתן לשינוי)
// ============================================================
// טוקנים בזיכרון: token -> { role, user, createdAt }
const sessions = {};
function makeToken() { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }

function checkCredentials(user, pass) {
  if (user === SUPER_USER && pass === SUPER_PASS) return 'super';
  const sec = db.secondaryUser || DEFAULT_SECONDARY;
  if (user === sec.user && pass === sec.pass) return 'secondary';
  return null;
}

// התחברות
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const role = checkCredentials((user || '').trim(), (pass || '').trim());
  if (!role) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  const token = makeToken();
  sessions[token] = { role, user: user.trim(), createdAt: Date.now() };
  res.json({ token, role, user: user.trim() });
});

// בדיקת תקפות טוקן (לכניסה אוטומטית)
app.get('/api/admin/me', (req, res) => {
  const s = sessions[req.headers['x-admin-token']];
  if (!s) return res.status(401).json({ error: 'לא מחובר' });
  res.json({ role: s.role, user: s.user });
});

// יציאה
app.post('/api/admin/logout', (req, res) => {
  delete sessions[req.headers['x-admin-token']];
  res.json({ ok: true });
});

function auth(req, res, next) {
  const s = sessions[req.headers['x-admin-token']];
  if (!s) return res.status(401).json({ error: 'לא מחובר' });
  req.adminRole = s.role;
  req.adminUser = s.user;
  next();
}

app.get('/api/admin/stations', auth, (req, res) => {
  res.json({ gameName: db.gameName, stations: db.stations });
});

app.post('/api/admin/game-name', auth, (req, res) => {
  db.gameName = (req.body.gameName || 'המשחק המשפחתי').toString();
  saveDB(); broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/station/:id', auth, memUpload.single('image'), async (req, res) => {
  const st = db.stations.find(s => s.id == req.params.id);
  if (!st) return res.status(404).json({ error: 'תחנה לא קיימת' });
  if (req.body.title !== undefined) st.title = req.body.title;
  if (req.body.questionType !== undefined) st.questionType = req.body.questionType;
  if (req.body.questionText !== undefined) st.questionText = req.body.questionText;
  if (req.body.correctAnswer !== undefined) st.correctAnswer = req.body.correctAnswer;
  if (req.body.points !== undefined) st.points = Number(req.body.points) || 10;
  if (req.body.imageLink) st.imageUrl = req.body.imageLink;  // לינק חיצוני
  if (req.file) {
    // המר את התמונה ל-WebP מוקטן ושמור כ-data URI בתוך db (מגובה אוטומטית ל-GitHub)
    try {
      const buf = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1000, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      st.imageUrl = 'data:image/webp;base64,' + buf.toString('base64');
    } catch (e) {
      console.warn('image processing failed:', e.message);
      return res.status(400).json({ error: 'עיבוד התמונה נכשל' });
    }
  }
  if (req.body.clearImage === 'true') st.imageUrl = '';
  saveDB();
  res.json({ ok: true, station: st });
});

// יצירת QR לתחנה
app.get('/api/admin/qr/:id', auth, async (req, res) => {
  const base = req.query.base || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/station/${req.params.id}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ url, qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: 'שגיאה ביצירת QR' });
  }
});

// אישור/דחיית תשובת תמונה
app.post('/api/admin/review', auth, (req, res) => {
  const { playerId, stationId, approve } = req.body;
  const player = db.players[playerId];
  if (!player || !player.answers[stationId]) return res.status(404).json({ error: 'לא נמצא' });
  const st = db.stations.find(s => s.id == stationId);
  const ans = player.answers[stationId];
  const base = st ? st.points : 10;
  ans.correct = !!approve;
  ans.basePoints = approve ? base : 0;
  ans.bonus = approve ? speedBonus(ans.timeMs) : 0;
  ans.points = approve ? (base + ans.bonus) : 0;
  saveDB(); broadcast();
  res.json({ ok: true });
});

// רשימת תשובות תמונה שממתינות לאישור
app.get('/api/admin/pending', auth, (req, res) => {
  const pending = [];
  Object.values(db.players).forEach(p => {
    Object.values(p.answers || {}).forEach(a => {
      if (a.correct === null && a.photoUrl) {
        pending.push({ playerId: p.id, name: p.name, team: p.team, stationId: a.stationId, photoUrl: a.photoUrl, answerText: a.answerText });
      }
    });
  });
  res.json({ pending });
});

// איפוס משחק (שומר שאלות, מוחק שחקנים ותשובות)
app.post('/api/admin/reset', auth, (req, res) => {
  db.players = {};
  db.submissions = [];
  saveDB(); broadcast();
  res.json({ ok: true });
});

// קבלת הגדרות (בונוס מהירות + פרטי מנהל משני - בלי הסיסמה)
app.get('/api/admin/settings', auth, (req, res) => {
  res.json({
    speedBonus: db.speedBonus,
    secondaryUserName: (db.secondaryUser || DEFAULT_SECONDARY).user,
    role: req.adminRole
  });
});

// עדכון הגדרות בונוס מהירות
app.post('/api/admin/speed-bonus', auth, (req, res) => {
  const { enabled, maxBonus, windowSec } = req.body;
  db.speedBonus = {
    enabled: enabled === true || enabled === 'true',
    maxBonus: Math.max(0, Number(maxBonus) || 0),
    windowSec: Math.max(1, Number(windowSec) || 60)
  };
  saveDB();
  res.json({ ok: true, speedBonus: db.speedBonus });
});

// שינוי המנהל המשני (שם וסיסמה). מותר למנהל-על, ולמנהל המשני עצמו.
app.post('/api/admin/secondary-credentials', auth, (req, res) => {
  if (req.adminRole !== 'super' && req.adminRole !== 'secondary') {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  const newUser = (req.body.user || '').trim();
  const newPass = (req.body.pass || '').trim();
  if (newUser.length < 3) return res.status(400).json({ error: 'שם משתמש חייב לפחות 3 תווים' });
  if (newPass.length < 4) return res.status(400).json({ error: 'סיסמה חייבת לפחות 4 תווים' });
  if (newUser === SUPER_USER) return res.status(400).json({ error: 'שם משתמש זה שמור למנהל-העל' });
  db.secondaryUser = { user: newUser, pass: newPass };
  saveDB();
  res.json({ ok: true, secondaryUserName: newUser });
});

// --- ניתוב דפים ---
app.get('/station/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'station.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// טען DB (כולל משיכה מ-GitHub אם מוגדר) ואז הפעל את השרת
loadDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🎮 המשחק רץ על פורט ${PORT}`);
    console.log(GH_ENABLED ? '☁️  גיבוי GitHub פעיל' : '💾 אחסון מקומי בלבד (גיבוי GitHub כבוי)');
  });
}).catch(err => {
  console.error('שגיאה בטעינת DB:', err);
  process.exit(1);
});
