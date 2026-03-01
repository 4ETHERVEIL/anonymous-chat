const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');

const app = express();
const BASE_URL = 'https://anonymous-chat-omega.vercel.app';

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
    secret: process.env.SESSION_SECRET || 'rahasia123456789',
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 hari
    }
  })
);

// ============ INITIALIZE DATABASE TABLES ============
async function initDB() {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create messages table
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

    // Create sessions table (for connect-pg-simple)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP NOT NULL
      )
    `);

    console.log('✅ Database tables ready');
  } catch (error) {
    console.error('❌ Database init error:', error.message);
  }
}

// Panggil initDB
initDB();

// ============ HELPER FUNCTIONS ============
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

// ============ TEST ROUTE ============
app.get('/api/test', async (req, res) => {
  try {
    const dbTest = await pool.query('SELECT NOW() as time');
    res.json({
      status: 'OK',
      time: dbTest.rows[0].time,
      database: 'Connected',
      session: req.sessionID ? 'Active' : 'No session',
      env: {
        node_env: process.env.NODE_ENV,
        db_url_set: !!process.env.DATABASE_URL
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// ============ ROUTES ============

// Halaman utama
app.get('/', (req, res) => {
  try {
    // Jika sudah login, redirect ke inbox
    if (req.session.username) {
      return res.redirect(`/inbox/${req.session.username}`);
    }
    
    let html = readHtml('index.html');
    res.send(html);
  } catch (error) {
    res.status(500).send('Error loading page');
  }
});

// Register username
app.post('/register', async (req, res) => {
  try {
    const { username } = req.body;
    
    console.log('📝 Register attempt:', username);
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username wajib diisi' });
    }

    // Bersihkan username (lowercase, no spaces)
    const cleanUsername = username.toLowerCase().trim().replace(/\s+/g, '');
    
    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username minimal 3 karakter' });
    }

    // Test database connection
    try {
      await pool.query('SELECT 1');
      console.log('✅ Database connected');
    } catch (dbErr) {
      console.error('❌ Database connection error:', dbErr.message);
      return res.status(500).json({ error: 'Koneksi database gagal' });
    }
    
    // Cek apakah user sudah ada
    let user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [cleanUsername]
    );

    if (user.rows.length === 0) {
      // Buat user baru
      console.log('👤 Creating new user:', cleanUsername);
      await pool.query(
        'INSERT INTO users (username) VALUES ($1)',
        [cleanUsername]
      );
    } else {
      console.log('👤 User already exists:', cleanUsername);
    }

    // Set session
    req.session.username = cleanUsername;
    
    // Save session manually
    req.session.save((err) => {
      if (err) {
        console.error('❌ Session save error:', err);
        return res.status(500).json({ error: 'Gagal menyimpan session' });
      }
      
      console.log('✅ Login successful for:', cleanUsername);
      
      res.json({ 
        success: true, 
        username: cleanUsername,
        redirect: `/inbox/${cleanUsername}`
      });
    });
    
  } catch (error) {
    console.error('❌ Register error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Terjadi kesalahan: ' + error.message });
  }
});

// Halaman tanya (public)
app.get('/ask/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    console.log('📨 Ask page accessed for:', username);
    
    // Cek apakah user ada
    const user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>User Tidak Ditemukan</title>
        <link rel="stylesheet" href="/style.css">
        </head>
        <body>
          <div class="container" style="text-align:center; margin-top:100px;">
            <h1>🔍 User Tidak Ditemukan</h1>
            <p>Username @${username} tidak terdaftar</p>
            <a href="/" class="btn" style="display:inline-block; margin-top:20px;">Buat Link Kamu</a>
          </div>
        </body>
        </html>
      `);
    }
    
    let html = readHtml('ask.html');
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{message}}', '');
    
    res.send(html);
    
  } catch (error) {
    console.error('Error in /ask:', error);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Kirim pertanyaan
app.post('/ask/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const { question } = req.body;
    
    console.log('📝 New question for:', username);
    
    if (!question || question.trim() === '') {
      let html = readHtml('ask.html');
      html = html.replace(/{{username}}/g, username);
      html = html.replace(/{{BASE_URL}}/g, BASE_URL);
      html = html.replace('{{message}}', '<div class="error-message">❌ Pertanyaan tidak boleh kosong</div>');
      return res.send(html);
    }
    
    // Simpan pertanyaan
    await pool.query(
      'INSERT INTO messages (username, question) VALUES ($1, $2)',
      [username, question]
    );
    
    console.log('✅ Question saved for:', username);
    
    // Tampilkan halaman dengan pesan sukses
    let html = readHtml('ask.html');
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{message}}', '<div class="success-message">✅ Pertanyaan terkirim!</div>');
    
    res.send(html);
    
  } catch (error) {
    console.error('Error in POST /ask:', error);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Halaman inbox (private)
app.get('/inbox/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    console.log('📬 Inbox accessed for:', username);
    
    // Cek session
    if (!req.session.username) {
      console.log('⛔ No session, redirecting to home');
      return res.redirect('/');
    }
    
    if (req.session.username !== username) {
      console.log(`⛔ Session mismatch: ${req.session.username} vs ${username}`);
      return res.redirect('/');
    }
    
    // Ambil pesan dari database
    const messages = await pool.query(
      `SELECT * FROM messages 
       WHERE username = $1 
       ORDER BY created_at DESC`,
      [username]
    );
    
    console.log(`📊 Found ${messages.rows.length} messages for ${username}`);
    
    // Tandai pesan yang sudah dibaca
    await pool.query(
      'UPDATE messages SET is_read = true WHERE username = $1 AND is_read = false',
      [username]
    );
    
    // Hitung pesan yang belum dibaca
    const unreadCount = messages.rows.filter(m => !m.is_read).length;
    
    // Generate HTML untuk pesan
    let messagesHtml = '';
    
    if (messages.rows.length === 0) {
      messagesHtml = '<p style="text-align:center; color:#999; padding:40px;">Belum ada pesan. Bagikan linkmu!</p>';
    } else {
      messagesHtml = messages.rows.map(msg => {
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
              <button onclick="answerMessage(${msg.id})" style="background:#4caf50; margin-top:10px; padding:8px; width:auto;">
                Balas
              </button>
            ` : ''}
          </div>
        `;
      }).join('');
    }
    
    let html = readHtml('inbox.html');
    html = html.replace(/{{username}}/g, username);
    html = html.replace(/{{BASE_URL}}/g, BASE_URL);
    html = html.replace('{{messages}}', messagesHtml);
    html = html.replace('{{total}}', messages.rows.length);
    html = html.replace('{{unread}}', unreadCount);
    
    res.send(html);
    
  } catch (error) {
    console.error('Error in /inbox:', error);
    res.status(500).send('Terjadi kesalahan');
  }
});

// Balas pesan
app.post('/answer/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    const { answer } = req.body;
    
    console.log(`💬 Answering message ${messageId}`);
    
    if (!answer || answer.trim() === '') {
      return res.status(400).json({ error: 'Balasan tidak boleh kosong' });
    }
    
    await pool.query(
      'UPDATE messages SET answer = $1, answered_at = CURRENT_TIMESTAMP WHERE id = $2',
      [answer, messageId]
    );
    
    console.log('✅ Answer saved');
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error in /answer:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

// API get unread messages (for notifications)
app.get('/api/messages/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    
    const messages = await pool.query(
      'SELECT COUNT(*) as total FROM messages WHERE username = $1 AND is_read = false',
      [username]
    );
    
    res.json({ unread: parseInt(messages.rows[0].total) });
    
  } catch (error) {
    console.error('Error in /api/messages:', error);
    res.json({ unread: 0 });
  }
});

// ============ ADMIN ROUTES ============

// Middleware admin
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
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Login</title>
        <link rel="stylesheet" href="/style.css">
    </head>
    <body style="display:flex; align-items:center; min-height:100vh;">
        <div class="container">
            <div class="card" style="max-width:400px; margin:0 auto;">
                <h2 style="text-align:center; color:#1877f2;">🔐 Admin Login</h2>
                <form method="POST" action="/admin/login">
                    <div class="form-group">
                        <input type="text" name="username" placeholder="Username" required>
                    </div>
                    <div class="form-group">
                        <input type="password" name="password" placeholder="Password" required>
                    </div>
                    <button type="submit">Login</button>
                </form>
                <p style="text-align:center; margin-top:20px; color:#999;">Default: admin / admin123</p>
            </div>
        </div>
    </body>
    </html>
  `);
});

// Proses login admin
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  // Ganti dengan credentials yang Anda inginkan
  if (username === 'admin' && password === 'admin123') {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Login Gagal</title>
      <link rel="stylesheet" href="/style.css">
      </head>
      <body style="display:flex; align-items:center;">
        <div class="container">
          <div class="card" style="max-width:400px; margin:0 auto;">
            <h2 style="color:#e41e3f;">Login Gagal</h2>
            <p>Username atau password salah</p>
            <a href="/admin/login" style="display:block; text-align:center; color:#1877f2;">Coba lagi</a>
          </div>
        </div>
      </body>
      </html>
    `);
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
    const users = await pool.query(`
      SELECT u.username, 
             COUNT(m.id) as total,
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
              <h1>📊 Admin Dashboard</h1>
              <form method="POST" action="/admin/logout">
                  <button type="submit" style="background:#e41e3f; width:auto; padding:8px 20px;">Logout</button>
              </form>
          </div>
          <div class="container">
              <h2 style="margin-bottom:20px;">Daftar Users</h2>
    `;
    
    if (users.rows.length === 0) {
      html += '<p>Belum ada user</p>';
    } else {
      users.rows.forEach(u => {
        html += `
          <div class="card">
            <h3>@${u.username} ${u.unread ? `<span class="badge">${u.unread} baru</span>` : ''}</h3>
            <p>Total pesan: ${u.total || 0}</p>
            <a href="/admin/user/${u.username}" style="color:#1877f2;">Lihat pesan →</a>
          </div>
        `;
      });
    }
    
    html += `</div></body></html>`;
    res.send(html);
    
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// Lihat pesan user tertentu
app.get('/admin/user/:username', isAdmin, async (req, res) => {
  try {
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
    
    if (messages.rows.length === 0) {
      html += '<p>Belum ada pesan</p>';
    } else {
      messages.rows.forEach(m => {
        const date = new Date(m.created_at).toLocaleString();
        html += `
          <div class="message">
            <p>${m.question}</p>
            ${m.answer ? `<p style="color:#1877f2;">💬 ${m.answer}</p>` : ''}
            <div class="message-time">${date}</div>
          </div>
        `;
      });
    }
    
    html += `</div></body></html>`;
    res.send(html);
    
  } catch (error) {
    res.status(500).send('Error');
  }
});

// ============ 404 HANDLER ============
app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
    <head><title>Halaman Tidak Ditemukan</title>
    <link rel="stylesheet" href="/style.css">
    </head>
    <body>
      <div class="container" style="text-align:center; margin-top:100px;">
        <h1>404</h1>
        <p>Halaman tidak ditemukan</p>
        <a href="/" style="color:#1877f2;">Kembali ke Home</a>
      </div>
    </body>
    </html>
  `);
});

// ============ EXPORT ============
module.exports = app;