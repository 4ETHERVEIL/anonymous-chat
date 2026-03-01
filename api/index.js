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

// ============ SESSION ============
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: 'sessions'
    }),
    secret: process.env.SESSION_SECRET || 'rahasia123',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  })
);

// ============ INIT DATABASE ============
async function initDB() {
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        is_pro BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Conversations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_admin_reply BOOLEAN DEFAULT FALSE,
        is_read BOOLEAN DEFAULT FALSE,
        sender_location VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Database ready');
  } catch (error) {
    console.error('DB Error:', error.message);
  }
}
initDB();

// ============ HELPERS ============
function readHtml(file) {
  return fs.readFileSync(path.join(__dirname, '../views', file), 'utf8');
}

// ============ ROUTES ============

// Home - Login page
app.get('/', (req, res) => {
  res.send(readHtml('login.html'));
});

// Login process
app.post('/login', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username wajib diisi' });
    }

    // Cek user
    let user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (username) VALUES ($1) RETURNING *',
        [username]
      );
    }

    const userId = user.rows[0].id;
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    // Buat conversation
    await pool.query(
      'INSERT INTO conversations (user_id, session_id) VALUES ($1, $2)',
      [userId, sessionId]
    );

    // Set session
    req.session.userId = userId;
    req.session.username = username;
    req.session.isPro = user.rows[0].is_pro;
    req.session.sessionId = sessionId;

    res.redirect(`/chat/${sessionId}`);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Chat page
app.get('/chat/:sessionId', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/');
    }

    const sessionId = req.params.sessionId;

    const messages = await pool.query(
      `SELECT m.* FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [sessionId]
    );

    let html = readHtml('chat.html');
    
    const messagesHtml = messages.rows.map(msg => {
      let hint = '';
      if (req.session.isPro && !msg.is_admin_reply) {
        hint = `<small style="display:block; margin-top:5px;">📍 ${msg.sender_location || 'Unknown'}</small>`;
      }
      
      return `
        <div class="message-bubble ${msg.is_admin_reply ? 'admin-message' : 'user-message'}">
          <div>${msg.message}</div>
          <div class="message-time">${new Date(msg.created_at).toLocaleString()}</div>
          ${hint}
        </div>
      `;
    }).join('');

    html = html.replace('{{messages}}', messagesHtml || '<p style="text-align:center;">Belum ada pesan</p>');
    html = html.replace(/{{username}}/g, req.session.username);
    html = html.replace(/{{isPro}}/g, req.session.isPro ? 'Pro' : 'Free');
    html = html.replace(/{{sessionId}}/g, sessionId);

    res.send(html);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// Send message
app.post('/send-message', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    const conv = await pool.query(
      'SELECT id FROM conversations WHERE session_id = $1',
      [sessionId]
    );

    await pool.query(
      'INSERT INTO messages (conversation_id, message, sender_location) VALUES ($1, $2, $3)',
      [conv.rows[0].id, message, 'Jakarta, Indonesia']
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages API
app.get('/api/messages', async (req, res) => {
  try {
    const { sessionId } = req.query;
    
    const messages = await pool.query(
      `SELECT m.* FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [sessionId]
    );

    res.json({ messages: messages.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upgrade to Pro
app.post('/upgrade', async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET is_pro = true WHERE id = $1',
      [req.session.userId]
    );
    req.session.isPro = true;
    res.redirect(`/chat/${req.session.sessionId}`);
  } catch (error) {
    res.status(500).send('Error');
  }
});

// ============ ADMIN ============
function isAdmin(req, res, next) {
  if (req.session.isAdmin) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.send(readHtml('admin-login.html').replace('{{error}}', ''));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    let html = readHtml('admin-login.html');
    html = html.replace('{{error}}', '<div class="error">Login gagal</div>');
    res.send(html);
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', isAdmin, async (req, res) => {
  const chats = await pool.query(`
    SELECT c.*, u.username, COUNT(m.id) as msg_count,
    SUM(CASE WHEN m.is_read=false AND m.is_admin_reply=false THEN 1 ELSE 0 END) as unread
    FROM conversations c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN messages m ON c.id = m.conversation_id
    GROUP BY c.id, u.username
    ORDER BY c.last_activity DESC
  `);

  let html = readHtml('admin.html');
  
  const listHtml = chats.rows.map(c => `
    <div class="card" onclick="location.href='/admin/conversation/${c.id}'">
      <h3>@${c.username} ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</h3>
      <p>Pesan: ${c.msg_count || 0}</p>
      <small>${new Date(c.last_activity).toLocaleString()}</small>
    </div>
  `).join('');

  html = html.replace('{{conversations}}', listHtml || '<p>Belum ada</p>');
  res.send(html);
});

app.get('/admin/conversation/:id', isAdmin, async (req, res) => {
  const messages = await pool.query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at',
    [req.params.id]
  );

  await pool.query(
    'UPDATE messages SET is_read=true WHERE conversation_id=$1 AND is_admin_reply=false',
    [req.params.id]
  );

  let html = readHtml('admin-conversation.html');
  
  const msgHtml = messages.rows.map(m => `
    <div class="message-bubble ${m.is_admin_reply ? 'admin-message' : 'user-message'}">
      <div>${m.message}</div>
      <div class="message-time">${new Date(m.created_at).toLocaleString()}</div>
      ${m.sender_location ? `<small>📍 ${m.sender_location}</small>` : ''}
    </div>
  `).join('');

  html = html.replace('{{messages}}', msgHtml);
  html = html.replace('{{conversationId}}', req.params.id);
  
  res.send(html);
});

app.post('/admin/reply/:id', isAdmin, async (req, res) => {
  await pool.query(
    'INSERT INTO messages (conversation_id, message, is_admin_reply) VALUES ($1, $2, $3)',
    [req.params.id, req.body.message, true]
  );
  res.redirect(`/admin/conversation/${req.params.id}`);
});

module.exports = app;