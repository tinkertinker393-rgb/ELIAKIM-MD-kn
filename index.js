const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay, 
    jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');

// Configuration from GitHub Secrets
const rawOwner = process.env.OWNER_NUMBER || '254746404008';
const ownerNumber = rawOwner.endsWith('@s.whatsapp.net') ? rawOwner : `${rawOwner}@s.whatsapp.net`;
const sessionDir = './auth_info';

// 1. Session Restoration (Base64 Decryption)
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
if (process.env.SESSION_ID && !fs.existsSync(`${sessionDir}/creds.json`)) {
    try {
        const decodedCreds = Buffer.from(process.env.SESSION_ID, 'base64').toString('utf-8');
        fs.writeFileSync(`${sessionDir}/creds.json`, decodedCreds);
        console.log("🔓 Session successfully decrypted from GitHub Secrets.");
    } catch (e) {
        console.log("❌ Error decrypting SESSION_ID: Check if it is a valid Base64 string.");
    }
}

const messageStore = new Map();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`🚀 Starting Bot using WA Version: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Digital Bot', 'Chrome', '110.0.0'],
        // --- TIMEOUT FIXES ---
        connectTimeoutMs: 120000,     // 2 minutes for slow GitHub runners
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
        msgRetryCounterCache: new Map(),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection Closed. Reason Code: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                console.log("♻️ Attempting to reconnect...");
                setTimeout(() => startBot(), 5000);
            }
        } else if (connection === 'open') {
            const digitalMsg = `
╔══════════════════════════════════════╗
║        🤖 SYSTEM CONNECTED 🤖        ║
╠══════════════════════════════════════╣
║ 🟢 User: ${sock.user.name || 'Bot'}     ║
║ 🟢 ID: ${jidNormalizedUser(sock.user.id)} ║
║ 🟢 Status: Decrypting & Logging...  ║
╚══════════════════════════════════════╝`;
            console.log(digitalMsg);
            await sock.sendMessage(ownerNumber, { text: digitalMsg });
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const senderName = msg.pushName || "Unknown User";

        // --- DECRYPT & LOG TO CONSOLE ---
        const messageText = msg.message?.conversation || 
                           msg.message?.extendedTextMessage?.text || 
                           msg.message?.imageMessage?.caption || "Non-text message";
        
        console.log(`📩 [LOG] From: ${senderName} (${jid}) | Message: ${messageText}`);

        // --- ALWAYS TYPING ---
        await sock.sendPresenceUpdate('composing', jid);

        // --- AUTO STATUS LIKE ---
        if (jid === 'status@broadcast') {
            const reactionEmojis = ['❤️', '🔥', '✨', '🙌', '💯', '⚡', '👑'];
            const randomEmoji = reactionEmojis[Math.floor(Math.random() * reactionEmojis.length)];
            await sock.sendMessage('status@broadcast', {
                react: { key: msg.key, text: randomEmoji }
            }, { statusJidList: [msg.key.participant] });
            console.log(`✅ Reacted ${randomEmoji} to status by ${senderName}`);
            return;
        }

        // Store for Anti-Delete
        messageStore.set(msg.key.id, msg);
        
        // Simple Ping Command
        if (messageText.toLowerCase() === '!ping') {
            await sock.sendMessage(jid, { text: '⚡ *Digital Speed:* Online & Active!' });
        }
    });

    // --- ANTI-DELETE FEATURE ---
    sock.ev.on('messages.delete', async (item) => {
        for (const key of item.keys) {
            const deleted = messageStore.get(key.id);
            if (deleted) {
                const sender = deleted.pushName || "Unknown";
                const content = deleted.message?.conversation || deleted.message?.extendedTextMessage?.text || "Media Content";
                
                const logMsg = `🗑️ [DELETED] ${sender} just deleted: ${content}`;
                console.log(logMsg);

                await sock.sendMessage(ownerNumber, { 
                    text: `🚫 *ANTI-DELETE ALERT*\n\n👤 *User:* ${sender}\n💬 *Message:* ${content}` 
                });
                messageStore.delete(key.id);
            }
        }
    });
}

startBot();
