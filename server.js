const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = 'admin2026';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// 根路径自动跳转到评审工作台
app.get('/', (req, res) => res.redirect('/review-workbench-multi.html'));

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { entries: [] }; }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 身份验证
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ role: 'admin', ok: true });
  res.json({ role: 'reviewer', ok: true });
});

// 获取全部作品数据 — 评委端过滤掉其他评委的评分
app.get('/api/entries', (req, res) => {
  const data = readData();
  const role = req.query.role;
  const reviewer = req.query.reviewer;

  if (role === 'reviewer' && reviewer) {
    // 评委端：只展示自己的评审 + 所有评委的姓名列表（不暴露具体分数）
    const filtered = {
      entries: data.entries.map(e => {
        const myReview = e.reviews.find(r => r.reviewer === reviewer);
        const reviewerNames = [...new Set(e.reviews.map(r => r.reviewer))];
        return {
          ...e,
          reviews: myReview ? [myReview] : [],
          reviewerNames,
          totalReviewers: e.reviews.length
        };
      })
    };
    return res.json(filtered);
  }

  // 管理员端：返回完整数据
  res.json(data);
});

// 管理员导入作品（批量添加）
app.post('/api/entries/import', (req, res) => {
  const { password, entries: newEntries } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });
  const data = readData();
  const startId = data.entries.length > 0 ? Math.max(...data.entries.map(e => e.id)) + 1 : 1;
  const added = newEntries.map((e, i) => ({
    id: startId + i,
    url: e.url,
    title: e.title || '',
    index: data.entries.length + i + 1,
    reviews: []
  }));
  data.entries.push(...added);
  writeData(data);
  res.json({ ok: true, count: added.length, entries: data.entries });
});

// 评委提交评审
app.put('/api/entries/:id/review', (req, res) => {
  const { reviewer, scores, hardChecks, notes } = req.body;
  if (!reviewer) return res.status(400).json({ error: '缺少评委名称' });
  const data = readData();
  const entry = data.entries.find(e => e.id === parseInt(req.params.id));
  if (!entry) return res.status(404).json({ error: '作品不存在' });

  const idx = entry.reviews.findIndex(r => r.reviewer === reviewer);
  const reviewData = { reviewer, scores, hardChecks, notes: notes || '', time: new Date().toISOString() };
  if (idx >= 0) entry.reviews[idx] = reviewData;
  else entry.reviews.push(reviewData);

  writeData(data);
  res.json({ ok: true, entry });
});

// 清空某个评委的评审
app.delete('/api/entries/:id/review/:reviewer', (req, res) => {
  const data = readData();
  const entry = data.entries.find(e => e.id === parseInt(req.params.id));
  if (!entry) return res.status(404).json({ error: '作品不存在' });
  entry.reviews = entry.reviews.filter(r => r.reviewer !== req.params.reviewer);
  writeData(data);
  res.json({ ok: true, entry });
});

// 管理员删除作品
app.delete('/api/entries/:id', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });
  const data = readData();
  data.entries = data.entries.filter(e => e.id !== parseInt(req.params.id));
  data.entries.forEach((e, i) => { e.index = i + 1; });
  writeData(data);
  res.json({ ok: true, entries: data.entries });
});

// 管理员清空所有数据
app.post('/api/reset', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '无管理员权限' });
  writeData({ entries: [] });
  res.json({ ok: true });
});

// 导出全部评审数据
app.get('/api/export', (req, res) => {
  const data = readData();
  res.json(data);
});

app.listen(PORT, () => {
  console.log('AI评审工作台已启动 → http://localhost:' + PORT);
  console.log('管理员密码: ' + ADMIN_PASSWORD);
});
