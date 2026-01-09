const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");
const path = require("path");
const zlib = require("zlib");
const os = require("os");

// --- CONFIGURATION ---
const SESSION_FOLDER = 'session';
const SETTINGS_FILE = 'settings.json';
const SESSION_ID = process.env.SESSION_ID; 
const OWNER_NUMBER = "254746404008"; 
const OWNER_JID = OWNER_NUMBER + "@s.whatsapp.net";
const PREFIX = "!";
const logger = pino({ level: 'silent' });

// --- MEMORY & SETTINGS ---
const msgCache = new Map();
const startTime = Date.now();

let botSettings = {
    antilink: { status: 'delete' },
    antidelete: { status: true, notification: ' *Eliakim MD Anti-Delete* 🇰🇪' },
    autostatus: { autoview: true, autolike: true }
};

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        botSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) { console.error("Settings load error"); }
}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 2));

const codingQuotes = [
    "“First, solve the problem. Then, write the code.” – John Johnson",
    "“Code is like humor. When you have to explain it, it’s bad.” – Cory House",
    "“Fix the cause, not the symptom.” – Steve Maguire",
    "“The best thing about a boolean is even if you are wrong, you are only off by a bit.”"
];

function runtime() {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

async function restoreSession() {
    await fs.ensureDir(SESSION_FOLDER);
    const credsPath = path.join(SESSION_FOLDER, 'creds.json');
    if (!fs.existsSync(credsPath) && SESSION_ID) {
        try {
            const base64Data = SESSION_ID.includes(';;;') ? SESSION_ID.split(';;;')[1] : SESSION_ID;
            const buffer = Buffer.from(base64Data, 'base64');
            let decoded;
            try { decoded = zlib.gunzipSync(buffer); } catch { decoded = buffer; }
            await fs.writeFile(credsPath, decoded);
        } catch (e) { console.log("❌ Session Restore Error"); }
    }
}

async function startBot() {
    await restoreSession();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const conn = makeWASocket({
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ["Eliakim MD ☠️🇰🇪", "Chrome", "1.0.0"],
        markOnlineOnConnect: true
    });

    conn.ev.on('creds.update', saveCreds);

    // --- 3-HOUR QUOTE TIMER ---
    setInterval(async () => {
        try {
            if (conn.user && OWNER_JID) {
                const quote = codingQuotes[Math.floor(Math.random() * codingQuotes.length)];
                await conn.sendMessage(OWNER_JID, { 
                    text: `💻 *ELIAKIM MD CODING QUOTE* 🇰🇪\n\n${quote}\n\n_Next quote in 3 hours..._` 
                });
            }
        } catch (e) {}
    }, 3 * 60 * 60 * 1000);

    conn.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || !m.key.remoteJid) return;

            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const participant = m.key.participant || from;
            const sender = jidNormalizedUser(participant);
            const isOwner = sender.startsWith(OWNER_NUMBER) || m.key.fromMe;
            const botNumber = conn.user ? jidNormalizedUser(conn.user.id) : null;

            if (!m.key.fromMe && from !== 'status@broadcast') {
                await conn.sendPresenceUpdate('composing', from);
            }

            const type = getContentType(m.message);
            const content = type === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const msgType = getContentType(content);
            const body = (msgType === 'conversation') ? content.conversation :
                         (msgType === 'extendedTextMessage') ? content.extendedTextMessage.text :
                         (content[msgType]?.caption) ? content[msgType].caption : '';

            // AUTO STATUS
            if (from === 'status@broadcast' && botSettings.autostatus.autoview) {
                await conn.readMessages([m.key]);
                if (botSettings.autostatus.autolike && m.key.participant) {
                    const statusEmojis = ['💛', '❤️', '💜', '🤍', '💙', '🇰🇪', '🔥'];
                    const emoji = statusEmojis[Math.floor(Math.random() * statusEmojis.length)];
                    await conn.sendMessage(from, { react: { key: m.key, text: emoji } }, { statusJidList: [m.key.participant, botNumber].filter(Boolean) });
                }
                return;
            }

            // COMMANDS
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args[0].toLowerCase();

                switch (command) {
                    case "ping":
                        const start = Date.now();
                        await conn.sendMessage(from, { react: { text: "☠️", key: m.key } });
                        const end = Date.now();
                        await conn.sendMessage(from, { 
                            text: `*Eliakim MD ☠️🇰🇪 Pong!*\n\n*Latency:* ${end - start}ms\n*Runtime:* ${runtime()}\n*RAM:* ${(os.freemem() / 1024 / 1024).toFixed(0)}MB / ${(os.totalmem() / 1024 / 1024).toFixed(0)}MB` 
                        }, { quoted: m });
                        break;

                    case "antilink":
                        if (!isOwner) return;
                        if (args[1] === "on") {
                            botSettings.antilink.status = 'delete';
                            saveSettings();
                            await conn.sendMessage(from, { text: "🛡️ *Anti-Link is now ALWAYS ON.*" });
                        } else if (args[1] === "off") {
                            botSettings.antilink.status = 'off';
                            saveSettings();
                            await conn.sendMessage(from, { text: "🔓 *Anti-Link is now OFF.*" });
                        }
                        break;

                    case "tagall":
                        if (!isGroup || !isOwner) return;
                        const group = await conn.groupMetadata(from);
                        let msg = `*📢 ELIAKIM MD TAGALL*\n\n`;
                        for (let i of group.participants) msg += ` @${i.id.split('@')[0]}`;
                        await conn.sendMessage(from, { text: msg, mentions: group.participants.map(a => a.id) });
                        break;
                }
            }

            // ANTI-LINK
            const linkRegex = /(https?:\/\/[^\s]+)/g;
            if (botSettings.antilink.status === 'delete' && isGroup && linkRegex.test(body) && !m.key.fromMe) {
                const groupMetadata = await conn.groupMetadata(from);
                const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => jidNormalizedUser(p.id));
                if (!admins.includes(sender) && botNumber && admins.includes(botNumber)) {
                    await conn.sendMessage(from, { delete: m.key });
                }
            }

            msgCache.set(m.key.id, m);
            if (msgCache.size > 2000) msgCache.delete(msgCache.keys().next().value);

        } catch (err) { console.error(err); }
    });

    // ANTI-DELETE LISTENER
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (botSettings.antidelete.status && update.update.protocolMessage?.type === 0) {
                const deletedId = update.update.protocolMessage.key.id;
                const cachedMsg = msgCache.get(deletedId);
                if (cachedMsg && OWNER_JID) {
                    const sender = jidNormalizedUser(cachedMsg.key.participant || cachedMsg.key.remoteJid);
                    let report = `${botSettings.antidelete.notification}\n\n`;
                    report += `👤 *Sender:* @${sender.split('@')[0]}\n`;
                    if (cachedMsg.key.remoteJid.endsWith('@g.us')) {
                        try {
                            const meta = await conn.groupMetadata(cachedMsg.key.remoteJid);
                            report += `📍 *Group:* ${meta.subject}\n`;
                        } catch (e) {}
                    }
                    await conn.sendMessage(OWNER_JID, { text: report, mentions: [sender] });
                    await conn.sendMessage(OWNER_JID, { forward: cachedMsg }, { quoted: cachedMsg });
                }
            }
        }
    });

    conn.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            console.log('✅ ELIAKIM MD ☠️🇰🇪 CONNECTED');

            // --- MODERN CONNECTED MESSAGE ---
            const connectedMsg = `
╔══════════════════╗
║   *ELIAKIM MD* ☠️🇰🇪   ║
╚══════════════════╝

*CONNECTED SUCCESSFULLY!* ✅

👤 *Owner:* ${OWNER_NUMBER}
⏱️ *Uptime:* ${runtime()}
🛡️ *Anti-Link:* ${botSettings.antilink.status === 'delete' ? 'ON' : 'OFF'}
🚫 *Anti-Delete:* ${botSettings.antidelete.status ? 'ON' : 'OFF'}
📺 *Auto-Status:* ${botSettings.autostatus.autoview ? 'ON' : 'OFF'}

💻 *System Info:*
- *RAM:* ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB
- *Platform:* ${os.platform()}

_Eliakim MD is now monitoring your chats..._
`.trim();

            await conn.sendMessage(OWNER_JID, { text: connectedMsg });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
