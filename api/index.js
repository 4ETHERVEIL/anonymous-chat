const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const UserAgent = require('user-agents');

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
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        is_pro BOOLEAN DEFAULT FALSE,
        pro_expiry TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create conversations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
        is_auto_generated BOOLEAN DEFAULT FALSE,
        sender_ip VARCHAR(45),
        sender_location VARCHAR(255),
        sender_device VARCHAR(255),
        sender_isp VARCHAR(255),
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

// Fungsi untuk mendapatkan info pengirim dari IP
async function getSenderInfo(ipAddress) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ipAddress}`);
    if (response.data && response.data.status === 'success') {
      return {
        location: `${response.data.city}, ${response.data.country}`,
        isp: response.data.isp,
        device: new UserAgent().toString()
      };
    }
  } catch (error) {
    console.error('Error getting sender info:', error.message);
  }
  
  return {
    location: 'Unknown',
    isp: 'Unknown',
    device: 'Unknown'
  };
}

// Fungsi untuk generate auto messages
function generateAutoMessage() {
  const messages = [
    "I've had a crush on you for years 😊",
    "You're so beautiful/handsome!",
    "I miss you so much",
    "You're my favorite person",
    "I think about you all the time",
    "You make me smile every day",
    "I wish I could tell you who I am",
    "You're literally perfect",
    "I love your vibe",
    "You're so underrated"
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

// ============ USER ROUTES ============

// Halaman utama - Login dengan username
app.get('/', (req, res) => {
  const html = readHtmlFile('login.html');
  res.send(html);
});

// Proses login dengan username
app.post('/login', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username tidak boleh kosong' });
    }

    // Cek apakah user sudah ada
    let user = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (user.rows.length === 0) {
      // Buat user baru
      user = await pool.query(
        'INSERT INTO users (username) VALUES ($1) RETURNING *',
        [username]
      );
    }

    // Set session
    req.session.userId = user.rows[0].id;
    req.session.username = username;
    req.session.isPro = user.rows[0].is_pro;

    // Buat session ID untuk chat
    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    
    // Simpan conversation
    await pool.query(
      'INSERT INTO conversations (user_id, session_id) VALUES ($1, $2)',
      [user.rows[0].id, sessionId]
    );

    req.session.sessionId = sessionId;

    // Generate auto message (30% chance)
    if (Math.random() < 0.3) {
      const conversation = await pool.query(
        'SELECT id FROM conversations WHERE session_id = $1',
        [sessionId]
      );
      
      const autoMessage = generateAutoMessage();
      
      await pool.query(
        `INSERT INTO messages 
         (conversation_id, message, is_auto_generated, sender_location, sender_device, sender_isp) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [conversation.rows[0].id, autoMessage, true, 'System', 'NGL Bot', 'System']
      );
    }

    // Redirect ke halaman chat
    res.redirect(`/chat/${sessionId}`);
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server Error: ' + error.message });
  }
});

// Halaman chat
app.get('/chat/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    
    // Validasi session
    if (!req.session.userId) {
      return res.redirect('/');
    }

    // Ambil pesan
    const messages = await pool.query(
      `SELECT m.*, c.session_id, u.is_pro, u.username
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       JOIN users u ON c.user_id = u.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [sessionId]
    );

    let html = readHtmlFile('chat.html');
    
    const messagesHtml = messages.rows.map(msg => {
      let hintHtml = '';
      
      // Tampilkan hint hanya untuk user Pro
      if (req.session.isPro && !msg.is_admin_reply && !msg.is_auto_generated) {
        hintHtml = `
          <div class="message-hint">
            <span>📍 ${msg.sender_location || 'Unknown'}</span>
            <span>📱 ${msg.sender_device ? msg.sender_device.substring(0, 30) + '...' : 'Unknown'}</span>
            <span>🌐 ${msg.sender_isp || 'Unknown'}</span>
          </div>
        `;
      } else if (msg.is_auto_generated) {
        hintHtml = '<div class="message-hint system">🤖 Auto-generated</div>';
      }
      
      return `
        <div class="message-bubble ${msg.is_admin_reply ? 'admin-message' : 'user-message'}">
          <div>${msg.message}</div>
          <div class="message-time">${formatDate(msg.created_at)}</div>
          ${hintHtml}
        </div>
      `;
    }).join('');

    html = html.replace('{{messages}}', messagesHtml || '<p style="text-align: center; color: #999; padding: 40px;">Belum ada pesan</p>');
    html = html.replace(/{{username}}/g, req.session.username);
    html = html.replace(/{{isPro}}/g, req.session.isPro ? 'Pro Member' : 'Free Member');
    html = html.replace(/{{sessionId}}/g, sessionId);
    html = html.replace('{{messagesCount}}', messages.rows.length);

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

// Kirim pesan anonymous
app.post('/send-message', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message tidak boleh kosong' });
    }

    const conversation = await pool.query(
      'SELECT id FROM conversations WHERE session_id = $1',
      [sessionId]
    );

    if (conversation.rows.length === 0) {
      return res.status(404).json({ error: 'Session tidak ditemukan' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const senderInfo = await getSenderInfo(clientIp);

    await pool.query(
      `INSERT INTO messages 
       (conversation_id, message, sender_ip, sender_location, sender_device, sender_isp) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversation.rows[0].id, message, clientIp, senderInfo.location, senderInfo.device, senderInfo.isp]
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

// API ambil pesan
app.get('/api/messages', async (req, res) => {
  try {
    const { sessionId } = req.query;
    
    if (!sessionId) {
      return res.json({ messages: [] });
    }

    const messages = await pool.query(
      `SELECT m.*, u.is_pro 
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       JOIN users u ON c.user_id = u.id
       WHERE c.session_id = $1
       ORDER BY m.created_at ASC`,
      [sessionId]
    );

    res.json({ messages: messages.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ============ PRO FEATURES ROUTES ============

// Halaman upgrade ke Pro
app.get('/upgrade', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }
  
  const html = readHtmlFile('upgrade.html');
  res.send(html.replace(/{{username}}/g, req.session.username));
});

// Proses upgrade (simulasi)
app.post('/upgrade/pro', async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + 1);

    await pool.query(
      'UPDATE users SET is_pro = true, pro_expiry = $1 WHERE id = $2',
      [expiryDate, userId]
    );

    req.session.isPro = true;
    
    res.redirect(`/chat/${req.session.sessionId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

// ============ ADMIN ROUTES ============

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
  
  let html = readHtmlFile('admin-login.html');
  html = html.replace('{{error}}', '');
  res.send(html);
});

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

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', isAdmin, async (req, res) => {
  try {
    const conversations = await pool.query(`
      SELECT 
        c.*,
        u.username,
        u.is_pro,
        COUNT(m.id) as message_count,
        SUM(CASE WHEN m.is_read = false AND m.is_admin_reply = false THEN 1 ELSE 0 END) as unread_count,
        MAX(m.created_at) as last_message
      FROM conversations c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id, u.username, u.is_pro
      ORDER BY last_message DESC NULLS LAST
    `);

    let html = readHtmlFile('admin.html');
    
    const conversationsHtml = conversations.rows.map(conv => `
      <div class="card" onclick="window.location.href='/admin/conversation/${conv.id}'" style="cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3>@${conv.username} ${conv.is_pro ? '⭐ PRO' : ''}</h3>
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

app.get('/admin/conversation/:id', isAdmin, async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversation = await pool.query(
      `SELECT c.*, u.username, u.is_pro 
       FROM conversations c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = $1`,
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

    let html = readHtmlFile('admin-conversation.html');
    
    const messagesHtml = messages.rows.map(msg => {
      let infoHtml = '';
      if (!msg.is_admin_reply) {
        infoHtml = `
          <div class="sender-info">
            <small>📍 ${msg.sender_location || 'Unknown'}</small>
            <small>📱 ${msg.sender_device ? msg.sender_device.substring(0, 50) + '...' : 'Unknown'}</small>
            <small>🌐 ${msg.sender_isp || 'Unknown'}</small>
            ${msg.sender_ip ? `<small>🔍 IP: ${msg.sender_ip}</small>` : ''}
            ${msg.is_auto_generated ? '<small>🤖 AUTO</small>' : ''}
          </div>
        `;
      }
      
      return `
        <div class="message-bubble ${msg.is_admin_reply ? 'admin-message' : 'user-message'}">
          <div>${msg.message}</div>
          <div class="message-time">${formatDate(msg.created_at)}</div>
          ${infoHtml}
        </div>
      `;
    }).join('');

    html = html.replace('{{conversationId}}', conversationId);
    html = html.replace('{{username}}', conversation.rows[0].username);
    html = html.replace('{{isPro}}', conversation.rows[0].is_pro ? '⭐ Pro Member' : 'Free Member');
    html = html.replace('{{createdAt}}', formatDate(conversation.rows[0].created_at));
    html = html.replace('{{messages}}', messagesHtml);

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Server Error: ' + error.message);
  }
});

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