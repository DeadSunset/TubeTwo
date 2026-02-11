const path = require('node:path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { initDb, dbPath } = require('./db');

const PORT = process.env.PORT || 3210;
const ROOT = path.resolve(__dirname, '..', '..');
const app = express();
const db = initDb();

app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(morgan('dev'));

app.use('/media', express.static('/'));
app.use('/thumbnails', express.static(path.join(ROOT, 'data', 'thumbnails')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', dbPath });
});

app.get('/api/channels', (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.is_system,
           COUNT(v.id) AS video_count
    FROM channels c
    LEFT JOIN videos v ON v.channel_id = c.id
    GROUP BY c.id
    ORDER BY c.is_system DESC, c.title COLLATE NOCASE ASC
  `).all();

  res.json(rows);
});

app.post('/api/sources', (req, res) => {
  const { name, sourcePath, sourceType } = req.body;

  if (!name || !sourcePath || !['channel', 'common'].includes(sourceType)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'name, sourcePath, sourceType(channel|common) are required',
    });
  }

  const stmt = db.prepare(`
    INSERT INTO sources (name, source_path, source_type)
    VALUES (@name, @sourcePath, @sourceType)
    ON CONFLICT(source_path) DO UPDATE SET
      name = excluded.name,
      source_type = excluded.source_type,
      updated_at = CURRENT_TIMESTAMP
  `);

  stmt.run({ name, sourcePath, sourceType });
  return res.status(201).json({ ok: true });
});

app.get('/api/sources', (_req, res) => {
  const sources = db.prepare(`
    SELECT id, name, source_path AS sourcePath, source_type AS sourceType, is_available AS isAvailable,
           created_at AS createdAt, updated_at AS updatedAt
    FROM sources
    ORDER BY created_at DESC
  `).all();

  res.json(sources);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`offline myTube listening on http://localhost:${PORT}`);
});
