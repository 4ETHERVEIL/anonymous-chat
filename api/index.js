const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');

const app = express();
const BASE_URL = 'https://anonymous-chat-omega.vercel.app';

// ============ DATABASE ============
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
      secure: true,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        answered_at TIMESTAMP
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

function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  
  if (diff < 60) return `${diff} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} hari lalu`;
  return `${Math.floor(diff / 2592000)} bulan lalu`;
}

// ============ ROUTES ============

// Halaman utama
app.get('/', (req, res) => {
  let html = readHtml('index.html');
  
  if (req.session.username) {
    return res.redirect(`/inbox/${req.session.username}`);
  }
  
  html = html.replace(/{{BASE_URL}}/g, BASE_URL);
  res.send(html);
});

// Register username
app.post('/register', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username wajib diisi' });
    }

    const cleanUsername = username.toLowerCase().trim().replace(/\s+/g, '');
    
    let user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [cleanUsername]
    );

    if (user.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (username) VALUES ($1)',
        [cleanUsername]
      );
    }

    req.session.username = cleanUsername;
    
    res.json({ 
      success: true, 
      username: cleanUsername,
      redirect: `/inbox/${cleanUsername}`,
      link: `${BASE_URL}/ask/${cleanUsername}`
    });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Halaman tanya (public)
app.get('/ask/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    
    const user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).send('User tidak ditemukan');
    }
    
    let html = readHtml('ask.html');
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{message}}', '');
    
    res.send(html);
    
  } catch (error) {
    res.status(500).send('Error');
  }
});

// Kirim pertanyaan
app.post('/ask/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const { question } = req.body;
    
    if (!question || question.trim() === '') {
      let html = readHtml('ask.html');
      html = html.replace(/{{username}}/g, username);
      html = html.replace(/{{BASE_URL}}/g, BASE_URL);
      html = html.replace('{{message}}', '<div class="error-message">Pertanyaan tidak boleh kosong</div>');
      return res.send(html);
    }
    
    await pool.query(
      'INSERT INTO messages (username, question) VALUES ($1, $2)',
      [username, question]
    );
    
    let html = readHtml('ask.html');
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{message}}', '<div class="success-message">✅ Pertanyaan terkirim!</div>');
    
    res.send(html);
    
  } catch (error) {
    res.status(500).send('Error');
  }
});

// Halaman inbox
app.get('/inbox/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    
    if (req.session.username !== username) {
      return res.redirect('/');
    }
    
    const messages = await pool.query(
      `SELECT * FROM messages 
       WHERE username = $1 
       ORDER BY created_at DESC`,
      [username]
    );
    
    await pool.query(
      'UPDATE messages SET is_read = true WHERE username = $1 AND is_read = false',
      [username]
    );
    
    let html = readHtml('inbox.html');
    
    const messagesHtml = messages.rows.map(msg => {
      const date = formatDate(msg.created_at);
      const answered = msg.answer ? '✓ Dibalas' : '';
      
      return `
        <div class="message" id="msg-${msg.id}">
          <p>${msg.question}</p>
          ${msg.answer ? `<p style="color:#1877f2; margin-top:10px;">💬 ${msg.answer}</p>` : ''}
          <div style="display:flex; justify-content:space-between; margin-top:10px;">
            <small>${date}</small>
            <small>${answered}</small>
          </div>
          ${!msg.answer ? `
            <button onclick="answerMessage(${msg.id})" style="background:#4caf50; margin-top:10px; padding:8px;">
              Balas
            </button>
          ` : ''}
        </div>
      `;
    }).join('');
    
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{messages}}', messagesHtml || '<p style="text-align:center; color:#999;">Belum ada pesan</p>');
    html = html.replace('{{total}}', messages.rows.length);
    html = html.replace('{{unread}}', messages.rows.filter(m => !m.is_read).length);
    
    res.send(html);
    
  } catch (error) {
    res.status(500).send('Error');
  }
});

// Balas pesan
app.post('/answer/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    const { answer } = req.body;
    
    await pool.query(
      'UPDATE messages SET answer = $1, answered_at = CURRENT_TIMESTAMP WHERE id = $2',
      [answer, messageId]
    );
    
    res.json({ success: true });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// API get unread messages
app.get('/api/messages/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    
    const messages = await pool.query(
      'SELECT COUNT(*) as total FROM messages WHERE username = $1 AND is_read = false',
      [username]
    );
    
    res.json({ unread: parseInt(messages.rows[0].total) });
    
  } catch (error) {
    res.json({ unread: 0 });
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
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Login</title>
        <link rel="stylesheet" href="/style.css">
    </head>
    <body style="display:flex; align-items:center;">
        <div class="container">
            <div class="card" style="max-width:400px; margin:0 auto;">
                <h2 style="text-align:center;">🔐 Admin Login</h2>
                <form method="POST" action="/admin/login">
                    <div class="form-group">
                        <input type="text" name="username" placeholder="Username" required>
                    </div>
                    <div class="form-group">
                        <input type="password" name="password" placeholder="Password" required>
                    </div>
                    <button type="submit">Login</button>
                </form>
            </div>
        </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login');
  }
});

app.get('/admin', isAdmin, async (req, res) => {
  const users = await pool.query(`
    SELECT u.username, COUNT(m.id) as total,
    SUM(CASE WHEN m.is_read = false THEN 1 ELSE 0 END) as unread
    FROM users u
    LEFT JOIN messages m ON u.username = m.username
    GROUP BY u.username
    ORDER BY u.created_at DESC
  `);
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Dashboard</title>
        <link rel="stylesheet" href="/style.css">
    </head>
    <body>
        <div class="header">
            <h1>Admin Dashboard</h1>
            <form method="POST" action="/admin/logout">
                <button type="submit" style="background:#e41e3f; width:auto; padding:8px 20px;">Logout</button>
            </form>
        </div>
        <div class="container">
            <h2>Users</h2>
  `;
  
  users.rows.forEach(u => {
    html += `
      <div class="card">
        <h3>@${u.username} ${u.unread ? `<span class="badge">${u.unread} baru</span>` : ''}</h3>
        <p>Total pesan: ${u.total || 0}</p>
        <a href="/admin/user/${u.username}" style="color:#1877f2;">Lihat pesan →</a>
      </div>
    `;
  });
  
  html += `</div></body></html>`;
  res.send(html);
});

app.get('/admin/user/:username', isAdmin, async (req, res) => {
  const username = req.params.username;
  
  const messages = await pool.query(
    'SELECT * FROM messages WHERE username = $1 ORDER BY created_at DESC',
    [username]
  );
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Pesan @${username}</title>
        <link rel="stylesheet" href="/style.css">
    </head>
    <body>
        <div class="header">
            <a href="/admin" style="color:white;">← Kembali</a>
            <h1>@${username}</h1>
            <form method="POST" action="/admin/logout">
                <button type="submit" style="background:#e41e3f; width:auto; padding:8px 20px;">Logout</button>
            </form>
        </div>
        <div class="container">
  `;
  
  messages.rows.forEach(m => {
    html += `
      <div class="message">
        <p>${m.question}</p>
        ${m.answer ? `<p style="color:#1877f2;">💬 ${m.answer}</p>` : ''}
        <div class="message-time">${new Date(m.created_at).toLocaleString()}</div>
      </div>
    `;
  });
  
  html += `</div></body></html>`;
  res.send(html);
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

module.exports = app;