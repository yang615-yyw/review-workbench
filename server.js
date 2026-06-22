const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.db');
const ADMIN_PASSWORD = 'admin2026';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// 根路径自动跳转到评审工作台
app.get('/', (req, res) => res.redirect('/review-workbench-multi.html'));

// ======================== 数据库初始化 ========================
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT DEFAULT '',
    index_num INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    reviewer TEXT NOT NULL,
    scores TEXT DEFAULT '{"content":0,"language":0,"tech":0}',
    hard_checks TEXT DEFAULT '{}',
    notes TEXT DEFAULT '',
    time TEXT DEFAULT '',
    UNIQUE(entry_id, reviewer)
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_entry ON reviews(entry_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer);
`);

// ======================== 数据读取映射 ========================
function entryToJSON(row) {
  const reviews = db.prepare('SELECT * FROM reviews WHERE entry_id = ?').all(row.id);
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    index: row.index_num,
    reviews: reviews.map(r => ({
      reviewer: r.reviewer,
      scores: JSON.parse(r.scores),
      hardChecks: JSON.parse(r.hard_checks),
      notes: r.notes,
      time: r.time
    }))
  };
}

function getAllEntries() {
  return db.prepare('SELECT * FROM entries ORDER BY index_num').all().map(entryToJSON);
}

// ======================== API ========================

// 身份验证
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ role: 'admin', ok: true });
  res.json({ role: 'reviewer', ok: true });
});

// 获取全部作品数据 — 评委端过滤掉其他评委的评分
app.get('/api/entries', (req, res) => {
  const role = req.query.role;
  const reviewer = req.query.reviewer;
  const entries = getAllEntries();

  if (role === 'reviewer' && reviewer) {
    const filtered = entries.map(e => {
      const myReview = e.reviews.find(r => r.reviewer === reviewer);
      const reviewerNames = [...new Set(e.reviews.map(r => r.reviewer))];
      return {
        ...e,
        reviews: myReview ? [myReview] : [],
        reviewerNames,
        totalReviewers: e.reviews.length
      };
    });
    return res.json({ entries: filtered });
  }

  res.json({ entries });
});

// 管理员导入作品（批量添加）
app.post('/api/entries/import', (req, res) => {
  const { password, entries: newEntries } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });

  const maxIdx = db.prepare('SELECT MAX(index_num) as m FROM entries').get().m || 0;

  const insertEntry = db.prepare('INSERT INTO entries (url, title, index_num) VALUES (?, ?, ?)');
  const insertMany = db.transaction((items) => {
    for (let i = 0; i < items.length; i++) {
      insertEntry.run(items[i].url, items[i].title || '', maxIdx + i + 1);
    }
  });

  insertMany(newEntries);
  const entries = getAllEntries();
  res.json({ ok: true, count: newEntries.length, entries });
});

// 评委提交评审
app.put('/api/entries/:id/review', (req, res) => {
  const { reviewer, scores, hardChecks, notes } = req.body;
  if (!reviewer) return res.status(400).json({ error: '缺少评委名称' });

  const entryId = parseInt(req.params.id);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) return res.status(404).json({ error: '作品不存在' });

  const scoresJSON = JSON.stringify(scores || { content: 0, language: 0, tech: 0 });
  const hardJSON = JSON.stringify(hardChecks || {});
  const noteStr = notes || '';
  const timeStr = new Date().toISOString();

  db.prepare(`
    INSERT INTO reviews (entry_id, reviewer, scores, hard_checks, notes, time)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, reviewer) DO UPDATE SET
      scores = excluded.scores,
      hard_checks = excluded.hard_checks,
      notes = excluded.notes,
      time = excluded.time
  `).run(entryId, reviewer, scoresJSON, hardJSON, noteStr, timeStr);

  const updated = entryToJSON(entry);
  res.json({ ok: true, entry: updated });
});

// 清空某个评委的评审
app.delete('/api/entries/:id/review/:reviewer', (req, res) => {
  const entryId = parseInt(req.params.id);
  const reviewer = req.params.reviewer;
  db.prepare('DELETE FROM reviews WHERE entry_id = ? AND reviewer = ?').run(entryId, reviewer);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  res.json({ ok: true, entry: entryToJSON(entry) });
});

// 管理员删除作品
app.delete('/api/entries/:id', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });

  const entryId = parseInt(req.params.id);
  // 先删评审再删作品（也可以用 CASCADE）
  db.prepare('DELETE FROM reviews WHERE entry_id = ?').run(entryId);
  db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);

  // 重新编号
  const entries = db.prepare('SELECT id FROM entries ORDER BY index_num').all();
  const updateIdx = db.prepare('UPDATE entries SET index_num = ? WHERE id = ?');
  const reindex = db.transaction(() => {
    entries.forEach((e, i) => updateIdx.run(i + 1, e.id));
  });
  reindex();

  res.json({ ok: true, entries: getAllEntries() });
});

// 管理员清空所有数据
app.post('/api/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });
  db.prepare('DELETE FROM reviews').run();
  db.prepare('DELETE FROM entries').run();
  res.json({ ok: true });
});

// 导出全部评审数据
app.get('/api/export', (req, res) => {
  res.json({ entries: getAllEntries() });
});

app.listen(PORT, () => {
  console.log('AI评审工作台已启动 → http://localhost:' + PORT);
  console.log('管理员密码: ' + ADMIN_PASSWORD);
  console.log('数据库引擎: SQLite (WAL模式) — 支持高并发');
});
