const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');

const app = express();

// ============ DATABASE CONNECTION ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============ MIDDLEWARE ============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/style.css', express.static(path.join(__dirname, '../public/style.css')));

// ============ SESSION CONFIGURATION ============
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: 'sessions',
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'rahasia-default-123',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  })
);

// ============ INITIALIZE DATABASE TABLES ============
async function initDatabase() {
  try {
    // Create conversations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_admin_reply BOOLEAN DEFAULT FALSE,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database tables ready');
  } catch (error) {
    console.error('❌ Database init error:', error.message);
  }
}

initDatabase();

// ============ HELPER FUNCTIONS ============
function readHtmlFile(filename) {
  return fs.readFileSync(path.join(__dirname, '../views', filename), 'utf8');
}

function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ============ USER ROUTES ============

// Halaman utama
app.get('/', async (req, res) => {
  try {
    if (!req.session.userId) {
      req.session.userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(7);
      
      await pool.query(
        'INSERT INTO conversations (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING',
        [req.session.userId]
      );
    }

    const messages = await pool.query(
      `SELECT m.* FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [req.session.userId]
    );

    let html = readHtmlFile('index.html');
    
    const messagesHtml = messages.rows.map(msg => `
      <div class="message-bubble ${msg.is_admin_reply ? 'admin-message' : 'user-message'}">
        <div>${msg.message}</div>
        <div class="message-time">${formatDate(msg.created_at)}</div>
      </div>
    `).join('');

    html = html.replace('{{messages}}', messagesHtml || '<p style="text-align: center; color: #999;">Belum ada pesan</p>');
    html = html.replace('{{userId}}', req.session.userId);

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

// Kirim pesan anonymous
app.post('/send-message', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message tidak boleh kosong' });
    }

    const conversation = await pool.query(
      'SELECT id FROM conversations WHERE session_id = $1',
      [req.session.userId]
    );

    if (conversation.rows.length === 0) {
      return res.status(404).json({ error: 'Session tidak ditemukan' });
    }

    await pool.query(
      'INSERT INTO messages (conversation_id, message, is_admin_reply) VALUES ($1, $2, $3)',
      [conversation.rows[0].id, message, false]
    );

    await pool.query(
      'UPDATE conversations SET last_activity = CURRENT_TIMESTAMP WHERE id = $1',
      [conversation.rows[0].id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// API ambil pesan (untuk auto refresh)
app.get('/api/messages', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({ messages: [] });
    }

    const messages = await pool.query(
      `SELECT m.* FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [req.session.userId]
    );

    res.json({ messages: messages.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ============ ADMIN ROUTES ============

// Middleware untuk cek admin
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

// Halaman login admin
app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) {
    return res.redirect('/admin');
  }
  
  let html = readHtmlFile('admin-login.html');
  html = html.replace('{{error}}', '');
  res.send(html);
});

// Proses login admin
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    let html = readHtmlFile('admin-login.html');
    html = html.replace('{{error}}', '<div class="error">Username atau password salah</div>');
    res.send(html);
  }
});

// Logout admin
app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Dashboard admin
app.get('/admin', isAdmin, async (req, res) => {
  try {
    const conversations = await pool.query(`
      SELECT 
        c.*,
        COUNT(m.id) as message_count,
        SUM(CASE WHEN m.is_read = false AND m.is_admin_reply = false THEN 1 ELSE 0 END) as unread_count,
        MAX(m.created_at) as last_message
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY last_message DESC NULLS LAST
    `);

    let html = readHtmlFile('admin.html');
    
    const conversationsHtml = conversations.rows.map(conv => `
      <div class="card" onclick="window.location.href='/admin/conversation/${conv.id}'" style="cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3>Session: ${conv.session_id.substring(0, 20)}...</h3>
            <p>Pesan: ${conv.message_count || 0} 
              ${conv.unread_count ? `<span class="badge">${conv.unread_count} baru</span>` : ''}
            </p>
            <small>Aktivitas terakhir: ${formatDate(conv.last_activity || conv.created_at)}</small>
          </div>
          <div>
            <small>Dibuat: ${formatDate(conv.created_at)}</small>
          </div>
        </div>
      </div>
    `).join('');

    html = html.replace('{{conversations}}', conversationsHtml || '<div class="card"><p style="text-align: center;">Belum ada percakapan</p></div>');
    
    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

// Lihat detail percakapan
app.get('/admin/conversation/:id', isAdmin, async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversation = await pool.query(
      'SELECT * FROM conversations WHERE id = $1',
      [conversationId]
    );

    if (conversation.rows.length === 0) {
      return res.status(404).send('Percakapan tidak ditemukan');
    }

    const messages = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );

    await pool.query(
      'UPDATE messages SET is_read = true WHERE conversation_id = $1 AND is_admin_reply = false',
      [conversationId]
    );

    let html = readHtmlFile('conversation.html');
    
    const messagesHtml = messages.rows.map(msg => `
      <div class="message-bubble ${msg.is_admin_reply ? 'admin-message' : 'user-message'}">
        <div>${msg.message}</div>
        <div class="message-time">${formatDate(msg.created_at)}</div>
      </div>
    `).join('');

    html = html.replace('{{conversationId}}', conversationId);
    html = html.replace('{{sessionId}}', conversation.rows[0].session_id);
    html = html.replace('{{createdAt}}', formatDate(conversation.rows[0].created_at));
    html = html.replace('{{messages}}', messagesHtml);

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

// Balas pesan
app.post('/admin/reply/:id', isAdmin, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { message } = req.body;

    if (!message || message.trim() === '') {
      return res.redirect(`/admin/conversation/${conversationId}`);
    }

    await pool.query(
      'INSERT INTO messages (conversation_id, message, is_admin_reply) VALUES ($1, $2, $3)',
      [conversationId, message, true]
    );

    res.redirect(`/admin/conversation/${conversationId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

module.exports = app;