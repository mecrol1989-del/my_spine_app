require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
const webpush = require('web-push');

// VAPID keys for push notifications
const VAPID_PUBLIC_KEY = 'BFryNn-yGoGoD8H8skull9MC1-zYxKWBgeH7KP761NuDL3extWoltYHEe8XOtg31ydllqCCJDWzymsv_VUGeRrI';
const VAPID_PRIVATE_KEY = '3-d6JopSn9YXQKLQARtL9jqR12VkpldPOmCKKWjiDkQ';

webpush.setVapidDetails(
    'mailto:admin@myspine.kz',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

// Push subscriptions (in-memory)
let pushSubscriptions = [];

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const CHANNEL_ID = process.env.CHANNEL_ID;
const API_TOKEN = process.env.API_TOKEN;
const API_BASE_URL = `https://api.1msg.io/${CHANNEL_ID}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // Trust Render's proxy
app.use(session({
    secret: process.env.SESSION_SECRET || 'super_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Setup Multer for parsing form data
const upload = multer();

// SSE Clients
let clients = [];

// Helper API request function — uses Node.js built-in fetch (Node 18+)
async function apiRequest(endpoint, method = 'GET', body = null) {
    const url = `${API_BASE_URL}${endpoint}?token=${API_TOKEN}`;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        console.log(`[API] ${method} ${endpoint}`);
        const response = await fetch(url, options);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error.message);
        throw error;
    }
}

// ==========================================
// SYNC: Pull existing messages from 1msg.io
// ==========================================

async function syncMessagesFrom1msg() {
    console.log('[Sync] Pulling existing messages from 1msg.io...');
    try {
        const data = await apiRequest('/messages', 'GET');
        const messages = data && data.messages;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            console.log('[Sync] No messages returned from API:', JSON.stringify(data).substring(0, 200));
            return { synced: 0, total: 0 };
        }

        let totalNew = 0;
        messages.forEach(msg => {
            if (!db.messageExists(msg.id)) {
                db.saveMessage({
                    id: msg.id,
                    chatId: msg.chatId || (msg.chatName ? msg.chatName + '@c.us' : 'unknown@c.us'),
                    body: msg.body || '',
                    fromMe: msg.fromMe || msg.self || 0,
                    senderName: msg.senderName || msg.chatName || '',
                    time: msg.time,
                    type: msg.type || 'chat',
                    caption: msg.caption || '',
                    quotedMsgId: msg.quotedMsgId || ''
                });
                totalNew++;
            }
        });

        console.log(`[Sync] Synced ${totalNew} new messages (total from API: ${messages.length})`);
        return { synced: totalNew, total: messages.length };
    } catch (e) {
        console.error('[Sync] Error syncing messages:', e.message);
        return { error: e.message };
    }
}

// Ensure Webhook is set up on startup
async function setupWebhook() {
    try {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (webhookUrl) {
            console.log(`Setting up webhook to ${webhookUrl}`);
            await apiRequest('/webhook', 'POST', { webhookUrl });
        }
    } catch (e) {
        console.error('Failed to setup webhook:', e);
    }
}

// Authentication Middleware
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};

// ==========================================
// ROUTES
// ==========================================

// Auth Routes
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (username === process.env.LOGIN_USER && password === process.env.LOGIN_PASS) {
        req.session.user = username;
        return res.json({ success: true, user: username });
    }

    return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

// WhatsApp API Routes (Protected)
app.get('/api/me', requireAuth, async (req, res) => {
    try {
        const data = await apiRequest('/me');
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status', requireAuth, async (req, res) => {
    try {
        const data = await apiRequest('/status');
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sync endpoint — pull messages from 1msg.io into local DB
app.post('/api/sync', requireAuth, async (req, res) => {
    try {
        const result = await syncMessagesFrom1msg();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// App Data Routes (Local DB)
app.get('/api/chats', requireAuth, (req, res) => {
    try {
        const chats = db.getChats();
        res.json(chats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/chats/:chatId/messages', requireAuth, (req, res) => {
    try {
        const messages = db.getChatMessages(req.params.chatId, 500);
        res.json(messages);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sending Messages
app.post('/api/chats/:chatId/send', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { body, quotedMsgId } = req.body;

    try {
        const payload = { chatId, body };
        if (quotedMsgId) payload.quotedMsgId = quotedMsgId;

        const response = await apiRequest('/sendMessage', 'POST', payload);

        // Save locally optimistically
        if (response.sent) {
            const tempMsg = {
                id: response.id || `temp_${Date.now()}`,
                chatId: chatId,
                body: body,
                fromMe: true,
                senderName: 'Me',
                time: Math.floor(Date.now() / 1000),
                type: 'chat',
                quotedMsgId: quotedMsgId
            };
            db.saveMessage(tempMsg);
        }

        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// For templates when out of 24h window
app.post('/api/chats/:chatId/send-template', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { namespace, template, language, params } = req.body;

    try {
        const payload = {
            chatId,
            namespace,
            template,
            language: language || { policy: "deterministic", code: "en" }
        };
        if (params && params.length > 0) {
            payload.params = params;
        }

        const response = await apiRequest('/sendTemplate', 'POST', payload);
        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Sending Files/Images
app.post('/api/chats/:chatId/send-file', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { body, filename, caption } = req.body;

    try {
        const payload = { chatId, body, filename };
        if (caption) payload.caption = caption;

        const response = await apiRequest('/sendFile', 'POST', payload);

        if (response.sent) {
            const tempMsg = {
                id: response.id,
                chatId: chatId,
                body: body,
                fromMe: true,
                senderName: 'Me',
                time: Math.floor(Date.now() / 1000),
                type: 'document',
                caption: caption || filename
            };
            db.saveMessage(tempMsg);
        }

        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chats/:chatId/read', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    if (req.body.messageId) {
        try {
            await apiRequest('/readMessage', 'POST', { messageId: req.body.messageId });
        } catch (e) { } // best effort
    }
    res.json({ success: true });
});

// ==========================================
// WEBHOOK (From 1msg.io)
// ==========================================

// Push notification subscription
app.post('/api/push/subscribe', requireAuth, (req, res) => {
    const subscription = req.body;
    // Avoid duplicates
    const exists = pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
        pushSubscriptions.push(subscription);
        console.log(`[Push] New subscription added. Total: ${pushSubscriptions.length}`);
    }
    res.json({ success: true });
});

// Send push notification to all subscribed devices
async function sendPushNotification(title, body, chatId) {
    const payload = JSON.stringify({
        title: title,
        body: body,
        tag: chatId,
        chatId: chatId,
        url: '/'
    });

    const expired = [];
    for (const sub of pushSubscriptions) {
        try {
            await webpush.sendNotification(sub, payload);
        } catch (err) {
            if (err.statusCode === 410 || err.statusCode === 404) {
                expired.push(sub);
            }
            console.error('[Push] Error:', err.statusCode || err.message);
        }
    }
    // Remove expired subscriptions
    pushSubscriptions = pushSubscriptions.filter(s => !expired.includes(s));
}

app.post('/webhook', (req, res) => {
    const data = req.body;

    const messages = Array.isArray(data.messages) ? data.messages : [];

    messages.forEach(msg => {
        if (!db.messageExists(msg.id)) {
            console.log(`[Webhook] New message saved: ${msg.id} in chat ${msg.chatId}`);

            const dbMsg = {
                id: msg.id,
                chatId: msg.chatId,
                body: msg.body,
                fromMe: msg.fromMe,
                senderName: msg.senderName,
                time: msg.time,
                type: msg.type,
                caption: msg.caption,
                quotedMsgId: msg.quotedMsgId
            };

            db.saveMessage(dbMsg);

            // Notify frontend via SSE
            notifyClients({ type: 'NEW_MESSAGE', data: dbMsg });

            // Send push notification for incoming messages (not from us)
            if (!msg.fromMe) {
                const sender = msg.senderName || msg.chatId.replace('@c.us', '').replace('@g.us', '');
                const preview = msg.body ? msg.body.substring(0, 100) : (msg.type || 'Media');
                sendPushNotification(`💬 ${sender}`, preview, msg.chatId);
            }
        }
    });

    // Process Delivery ACKs
    if (Array.isArray(data.ack)) {
        data.ack.forEach(ack => {
            console.log(`[Webhook] ACK received for ${ack.id}: ${ack.status}`);
            notifyClients({ type: 'ACK_UPDATE', data: ack });
        });
    }

    res.status(200).send('OK');
});

// ==========================================
// SSE (Real-time updates)
// ==========================================

app.get('/api/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientId = uuidv4();
    const newClient = {
        id: clientId,
        res
    };

    clients.push(newClient);
    console.log(`[SSE] Client connected: ${clientId}`);

    req.on('close', () => {
        console.log(`[SSE] Client disconnected: ${clientId}`);
        clients = clients.filter(c => c.id !== clientId);
    });
});

function notifyClients(message) {
    clients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(message)}\n\n`);
    });
}

// ==========================================
// STARTUP
// ==========================================

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`API Base: ${API_BASE_URL}`);

    // Auto-sync messages from 1msg.io on startup
    const syncResult = await syncMessagesFrom1msg();
    console.log('[Startup] Sync result:', syncResult);

    // Setup webhook if URL configured
    if (process.env.WEBHOOK_URL) {
        await setupWebhook();
    }

    // Periodic auto-sync every 60 seconds
    setInterval(async () => {
        try {
            const result = await syncMessagesFrom1msg();
            if (result.synced > 0) {
                console.log(`[Auto-sync] ${result.synced} new messages`);
                // Notify all SSE clients about new messages
                notifyClients({ type: 'SYNC_UPDATE', data: { synced: result.synced } });
            }
        } catch (e) {
            console.error('[Auto-sync] Failed:', e.message);
        }
    }, 60 * 1000); // every 60 seconds

    console.log('[Startup] Auto-sync enabled (every 60s)');
});
