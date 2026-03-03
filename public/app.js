// App State
let currentChatId = null;
let chats = [];
let messages = [];
let evtSource = null;

// DOM Elements
const screens = {
    login: document.getElementById('login-screen'),
    app: document.getElementById('app-screen')
};

const elems = {
    loginForm: document.getElementById('login-form'),
    usernameInput: document.getElementById('username'),
    passwordInput: document.getElementById('password'),
    loginError: document.getElementById('login-error'),

    chatList: document.getElementById('chat-list'),
    chatArea: document.getElementById('chat-area'),
    noChatSelected: document.getElementById('no-chat-selected'),

    currentChatName: document.getElementById('current-chat-name'),
    currentChatAvatar: document.getElementById('current-chat-avatar'),
    messagesContainer: document.getElementById('messages-container'),

    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    backBtn: document.getElementById('back-to-list'),
    logoutBtn: document.getElementById('logout-btn'),

    searchChats: document.getElementById('search-chats'),
    newChatBtn: document.getElementById('new-chat-btn'),
    newChatModal: document.getElementById('new-chat-modal'),
    closeModal: document.getElementById('close-modal'),
    startNewChatBtn: document.getElementById('start-new-chat'),
    newPhoneInput: document.getElementById('new-phone'),

    fileOverlay: document.getElementById('file-overlay'),
    fileInput: document.getElementById('file-input'),
    cancelFileBtn: document.getElementById('cancel-file'),
    sendFileBtn: document.getElementById('send-file-btn'),
    filePreview: document.getElementById('file-preview'),
    fileCaption: document.getElementById('file-caption'),

    toast: document.getElementById('toast')
};

// Initialize
document.addEventListener('DOMContentLoaded', checkAuthStatus);

// ==========================================
// Authentication
// ==========================================

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();

        if (data.loggedIn) {
            showScreen('app');
            initApp();
        } else {
            showScreen('login');
        }
    } catch (e) {
        showToast('Error connecting to server');
    }
}

elems.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = elems.usernameInput.value;
    const password = elems.passwordInput.value;

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (data.success) {
            showScreen('app');
            initApp();
        } else {
            elems.loginError.textContent = data.error || 'Login failed';
        }
    } catch (e) {
        elems.loginError.textContent = 'Network error';
    }
});

elems.logoutBtn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    if (evtSource) {
        evtSource.close();
        evtSource = null;
    }
    showScreen('login');
    resetAppState();
});

// ==========================================
// Main App Logic
// ==========================================

async function initApp() {
    // Sync existing dialogs from 1msg.io on first load
    showToast('Syncing messages from 1msg.io...');
    try {
        const syncRes = await fetch('/api/sync', { method: 'POST' });
        const syncData = await syncRes.json();
        if (syncData.synced > 0) {
            showToast(`Synced ${syncData.synced} messages!`);
        } else {
            showToast('Messages synced ✓');
        }
    } catch (e) {
        console.error('Sync failed', e);
    }

    await loadChats();
    initSSE();

    // Auto resize textarea
    elems.messageInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        if (this.value === '') this.style.height = 'auto';
    });

    // Send on Enter
    elems.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    elems.sendBtn.addEventListener('click', sendMessage);

    // Search
    elems.searchChats.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        renderChats(chats.filter(c =>
            (c.chat_id && c.chat_id.toLowerCase().includes(term)) ||
            (c.sender_name && c.sender_name.toLowerCase().includes(term))
        ));
    });

    // Mobile Back button
    elems.backBtn.addEventListener('click', () => {
        elems.chatArea.classList.add('hidden');
        elems.noChatSelected.style.display = 'none';
        currentChatId = null;
        document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    });

    // Modals
    elems.newChatBtn.addEventListener('click', () => {
        elems.newChatModal.classList.remove('hidden');
        elems.newPhoneInput.focus();
    });

    elems.closeModal.addEventListener('click', () => {
        elems.newChatModal.classList.add('hidden');
    });

    elems.startNewChatBtn.addEventListener('click', () => {
        let phone = elems.newPhoneInput.value.replace(/\D/g, '');
        if (phone) {
            const chatId = `${phone}@c.us`;
            elems.newChatModal.classList.add('hidden');
            elems.newPhoneInput.value = '';
            openChat(chatId, phone);
        }
    });

    // File attachments
    elems.attachBtn.addEventListener('click', () => {
        if (!currentChatId) return;
        elems.fileInput.click();
    });

    elems.fileInput.addEventListener('change', handleFileSelect);
    elems.cancelFileBtn.addEventListener('click', () => {
        elems.fileOverlay.classList.add('hidden');
        elems.fileInput.value = '';
    });
    elems.sendFileBtn.addEventListener('click', sendFile);

    // Manual sync button
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            syncBtn.querySelector('i').classList.add('fa-spin');
            try {
                const res = await fetch('/api/sync', { method: 'POST' });
                const data = await res.json();
                showToast(`Synced ${data.synced || 0} new messages`);
                await loadChats();
                if (currentChatId) {
                    openChat(currentChatId, elems.currentChatName.textContent);
                }
            } catch (e) {
                showToast('Sync failed');
            }
            syncBtn.querySelector('i').classList.remove('fa-spin');
        });
    }
}

function resetAppState() {
    currentChatId = null;
    chats = [];
    messages = [];
    elems.chatList.innerHTML = '';
    elems.messagesContainer.innerHTML = '';
    elems.chatArea.classList.add('hidden');
    elems.noChatSelected.classList.remove('hidden');
}

// ==========================================
// SSE / Real-time Updates
// ==========================================

function initSSE() {
    if (evtSource) evtSource.close();

    evtSource = new EventSource('/api/events');

    evtSource.onmessage = function (event) {
        const data = JSON.parse(event.data);

        if (data.type === 'NEW_MESSAGE') {
            handleNewMessage(data.data);
        } else if (data.type === 'ACK_UPDATE') {
            handleAckUpdate(data.data);
        }
    };

    evtSource.onerror = function (err) {
        console.error('SSE Error', err);
        evtSource.close();
        setTimeout(initSSE, 5000); // Reconnect
    };
}

function handleNewMessage(msg) {
    // If it's for current chat, render it
    if (msg.chatId === currentChatId) {
        // Prevent duplicate rendering
        if (!messages.find(m => m.id === msg.id)) {
            messages.push(msg);
            renderMessage(msg, true);
            scrollToBottom();

            // Mark as read
            fetch(`/api/chats/${currentChatId}/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messageId: msg.id })
            });
        }
    } else {
        // Play notification sound if not in focus
        if (!msg.fromMe) {
            showToast(`New message from ${formatPhone(msg.chatId)}`);
        }
    }

    // Update chat list
    loadChats();
}

function handleAckUpdate(ack) {
    const tickEl = document.getElementById(`tick-${ack.id}`);
    if (tickEl) {
        tickEl.innerHTML = getTickHtml(ack.status);
    }
}

// ==========================================
// API & Rendering Calls
// ==========================================

async function loadChats() {
    try {
        const res = await fetch('/api/chats');
        chats = await res.json();
        renderChats(chats);
    } catch (e) {
        console.error('Failed to load chats', e);
    }
}

function renderChats(chatData) {
    elems.chatList.innerHTML = '';

    if (chatData.length === 0) {
        elems.chatList.innerHTML = '<div class="empty-state" style="padding: 20px; text-align: center; color: var(--text-secondary);">No chats yet. Click + to start one.</div>';
        return;
    }

    chatData.forEach(chat => {
        const el = document.createElement('div');
        el.className = `chat-item ${chat.chat_id === currentChatId ? 'active' : ''}`;
        el.dataset.id = chat.chat_id;

        const phone = formatPhone(chat.chat_id);
        const time = formatTime(chat.time);

        let msgPreview = '';
        if (chat.type === 'image' || chat.type === 'video' || chat.type === 'document') {
            msgPreview = `<i class="fas fa-${chat.type === 'document' ? 'file' : 'camera'}"></i> ${chat.type}`;
        } else if (chat.body) {
            msgPreview = chat.body.substring(0, 30) + (chat.body.length > 30 ? '...' : '');
        }

        const tickHtml = chat.from_me === 1 ? `<span class="ticks" style="margin-right: 5px">${getTickHtml('sent')}</span>` : '';

        el.innerHTML = `
            <div class="chat-avatar">${phone.charAt(0)}</div>
            <div class="chat-info">
                <div class="chat-title-time">
                    <div class="chat-title">${chat.chat_id.replace('@c.us', '').replace('@g.us', '')}</div>
                    <div class="chat-time">${time}</div>
                </div>
                <div class="chat-last-message">
                    ${tickHtml}${msgPreview}
                </div>
            </div>
        `;

        el.addEventListener('click', () => openChat(chat.chat_id, phone));
        elems.chatList.appendChild(el);
    });
}

async function openChat(chatId, title) {
    currentChatId = chatId;

    // Update UI
    document.querySelectorAll('.chat-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === chatId);
    });

    elems.noChatSelected.style.display = 'none';
    elems.chatArea.classList.remove('hidden');
    elems.currentChatName.textContent = title || formatPhone(chatId);
    elems.currentChatAvatar.textContent = (title || chatId).charAt(0);
    const statusEl = document.getElementById('current-chat-status');
    if (statusEl) statusEl.textContent = chatId.includes('@g.us') ? 'Group' : 'WhatsApp Account';

    // Mobile view handling
    if (window.innerWidth <= 768) {
        elems.chatArea.style.display = 'flex';
    }

    // Load messages
    elems.messagesContainer.innerHTML = '<div class="loading-spinner"><i class="fas fa-circle-notch fa-spin"></i></div>';

    try {
        const res = await fetch(`/api/chats/${chatId}/messages`);
        messages = await res.json();

        elems.messagesContainer.innerHTML = '';

        if (messages.length === 0) {
            elems.messagesContainer.innerHTML = '<div class="date-system">Start of conversation</div>';
        } else {
            let lastDateStr = null;

            messages.forEach((msg, index) => {
                const msgDate = new Date(msg.time * 1000);
                const dateStr = msgDate.toLocaleDateString();

                if (dateStr !== lastDateStr) {
                    const dateEl = document.createElement('div');
                    dateEl.className = 'date-system';
                    dateEl.textContent = msgDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                    elems.messagesContainer.appendChild(dateEl);
                    lastDateStr = dateStr;
                }

                // Determine if first in group
                const prevMsg = index > 0 ? messages[index - 1] : null;
                const isMineNow = msg.fromMe || msg.from_me === 1;
                const wasMine = prevMsg ? (prevMsg.fromMe || prevMsg.from_me === 1) : null;
                const isFirst = !prevMsg || wasMine !== isMineNow || (msg.time - prevMsg.time > 300);

                renderMessage(msg, isFirst);
            });
            scrollToBottom();

            // Mark last message as read if from them
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && !lastMsg.fromMe) {
                fetch(`/api/chats/${chatId}/read`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageId: lastMsg.id })
                });
            }
        }
    } catch (e) {
        console.error('Failed to load messages', e);
        showToast('Error loading messages');
    }
}

function renderMessage(msg, isFirstOfGroup = false) {
    const el = document.createElement('div');
    const isMine = msg.fromMe || msg.from_me === 1; // handle both DB row and newly sent formats

    el.className = `message-row ${isMine ? 'msg-out' : 'msg-in'} ${isFirstOfGroup ? 'first-of-group' : ''}`;

    let contentHtml = '';
    const raw = msg.raw_data || msg;
    const type = msg.type || 'chat';

    // Media rendering
    if (type === 'image') {
        contentHtml = `<div class="message-media"><img src="${msg.body}" alt="Image"></div>`;
        if (msg.caption) contentHtml += `<div>${escapeHtml(msg.caption)}</div>`;
    }
    else if (type === 'video') {
        contentHtml = `<div class="message-media"><video src="${msg.body}" controls></video></div>`;
        if (msg.caption) contentHtml += `<div>${escapeHtml(msg.caption)}</div>`;
    }
    else if (type === 'document' || type === 'audio' || type === 'ptt' || type === 'voice') {
        let icon = type === 'document' ? 'file-alt' : 'microphone';
        let name = msg.caption || 'Document';
        contentHtml = `
            <div class="message-document">
                <i class="fas fa-${icon}"></i>
                <a href="${msg.body}" target="_blank" style="color:inherit;text-decoration:none">${escapeHtml(name)}</a>
            </div>`;
    }
    else {
        // Text
        contentHtml = `<div class="message-content">${escapeHtml(msg.body || '')}</div>`;
    }

    const timeStr = formatTime(msg.time);

    // Status ticks for outgoing
    let ticksHtml = '';
    if (isMine) {
        ticksHtml = `<span class="ticks" id="tick-${msg.id}">${getTickHtml('sent')}</span>`; // By default show sent. Webhooks update it.
    }

    el.innerHTML = `
        <div class="message">
            ${contentHtml}
            <div class="message-meta">
                <span class="time">${timeStr}</span>
                ${ticksHtml}
            </div>
        </div>
    `;

    elems.messagesContainer.appendChild(el);
}

async function sendMessage() {
    if (!currentChatId) return;

    const text = elems.messageInput.value.trim();
    if (!text) return;

    elems.messageInput.value = '';
    elems.messageInput.style.height = 'auto'; // Reset size

    try {
        const res = await fetch(`/api/chats/${currentChatId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: text })
        });

        const data = await res.json();
        if (data.sent) {
            // Optimistic rendering
            const newMsg = {
                id: data.id,
                chatId: currentChatId,
                body: text,
                fromMe: true,
                time: Math.floor(Date.now() / 1000),
                type: 'chat'
            };
            messages.push(newMsg);
            renderMessage(newMsg, messages.length === 1 || !messages[messages.length - 2].fromMe);
            scrollToBottom();
            loadChats(); // refresh list
        } else {
            showToast('Failed to send: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        showToast('Network error');
    }
}

// ==========================================
// File Upload logic
// ==========================================

let currentFileBase64 = null;

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        currentFileBase64 = e.target.result;

        elems.fileOverlay.classList.remove('hidden');
        elems.fileCaption.value = '';
        elems.fileCaption.focus();

        // Preview
        elems.filePreview.innerHTML = '';
        if (file.type.startsWith('image/')) {
            elems.filePreview.innerHTML = `<img src="${currentFileBase64}" alt="Preview">`;
        } else {
            elems.filePreview.innerHTML = `<i class="fas fa-file-alt"></i><br>${file.name}`;
        }
    };
    reader.readAsDataURL(file);
}

async function sendFile() {
    if (!currentChatId || !currentFileBase64) return;

    const fileInput = elems.fileInput;
    const file = fileInput.files[0];
    const caption = elems.fileCaption.value.trim();

    elems.fileOverlay.classList.add('hidden');
    elems.sendFileBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
        const res = await fetch(`/api/chats/${currentChatId}/send-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                body: currentFileBase64,
                filename: file.name,
                caption: caption
            })
        });

        const data = await res.json();
        if (data.sent) {
            // Force reload chats to get the saved message
            setTimeout(() => { openChat(currentChatId, elems.currentChatName.textContent); }, 1000);
        } else {
            showToast('Failed to send file');
        }
    } catch (e) {
        showToast('Error sending file');
    } finally {
        elems.sendFileBtn.innerHTML = 'Send <i class="fas fa-paper-plane"></i>';
        fileInput.value = '';
        currentFileBase64 = null;
    }
}


// ==========================================
// Utils
// ==========================================

function showScreen(screen) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[screen].classList.remove('hidden');
}

function scrollToBottom() {
    elems.messagesContainer.scrollTop = elems.messagesContainer.scrollHeight;
}

function formatPhone(chatId) {
    if (!chatId) return '';
    return chatId.split('@')[0];
}

function formatTime(unixSeconds) {
    const date = new Date(unixSeconds * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getTickHtml(status) {
    if (status === 'viewed') return '<i class="fas fa-check-double read"></i>';
    if (status === 'delivered') return '<i class="fas fa-check-double"></i>';
    if (status === 'sent') return '<i class="fas fa-check"></i>';
    return '<i class="far fa-clock"></i>'; // pending
}

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showToast(msg) {
    elems.toast.textContent = msg;
    elems.toast.classList.remove('hidden');
    setTimeout(() => {
        elems.toast.classList.add('hidden');
    }, 3000);
}
