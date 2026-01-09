const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");
const path = require("path");
const zlib = require("zlib");
const os = require("os");

// --- CONFIGURATION ---
const SESSION_FOLDER = 'session';
const SESSION_ID = process.env.SESSION_ID; 
const OWNER_NUMBER = "254746404008"; // Your number
const OWNER_JID = OWNER_NUMBER + "@s.whatsapp.net";
const PREFIX = "!";
const logger = pino({ level: 'silent' });

const startTime = Date.now();
const msgCache = new Map();

// --- UTILS ---
function runtime() {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

async function downloadMedia(message) {
    let type = Object.keys(message)[0];
    let m = message[type];
    if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
        m = message[type].message;
        type = Object.keys(m)[0];
        m = m[type];
    }
    const stream = await downloadContentFromMessage(m, type.replace('Message', ''));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) { buffer = Buffer.concat([buffer, chunk]); }
    return buffer;
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
        } catch (e) { console.log("❌ Session Error"); }
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
        browser: ["Eliakim MD", "Chrome", "1.0.0"],
        markOnlineOnConnect: true
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || !m.key.remoteJid) return;

            const from = m.key.remoteJid;
            const participant = m.key.participant || from;
            const sender = jidNormalizedUser(participant);
            const botNumber = conn.user ? jidNormalizedUser(conn.user.id) : null;

            // --- ALWAYS TYPING LOGIC ---
            // This makes the bot show "typing..." whenever it receives a message
            if (from !== 'status@broadcast') {
                await conn.sendPresenceUpdate('composing', from);
            }

            msgCache.set(m.key.id, m);
            if (msgCache.size > 2000) msgCache.delete(msgCache.keys().next().value);

            const type = getContentType(m.message);
            const content = type === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const msgType = getContentType(content);
            const body = (msgType === 'conversation') ? content.conversation :
                         (msgType === 'extendedTextMessage') ? content.extendedTextMessage.text :
                         (content[msgType]?.caption) ? content[msgType].caption : '';

            // AUTO STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                const statusEmojis = ['🤍', '🔥', '🇰🇪', '💎', '💜'];
                const emoji = statusEmojis[Math.floor(Math.random() * statusEmojis.length)];
                await conn.sendMessage(from, { react: { key: m.key, text: emoji } }, { statusJidList: [participant, botNumber].filter(Boolean) });
                return;
            }

            // COMMANDS
            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();

                if (command === "vv" || command === "retrieve") {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return conn.sendMessage(from, { text: "❌ Reply to a View Once media." });
                    const isVo = quoted.viewOnceMessageV2 || quoted.viewOnceMessage;
                    if (!isVo) return conn.sendMessage(from, { text: "❌ Not a View Once message." });
                    
                    const buffer = await downloadMedia(isVo);
                    const voType = Object.keys(isVo.message)[0];
                    if (voType === 'imageMessage') {
                        await conn.sendMessage(from, { image: buffer, caption: isVo.message.imageMessage.caption }, { quoted: m });
                    } else {
                        await conn.sendMessage(from, { video: buffer, caption: isVo.message.videoMessage.caption }, { quoted: m });
                    }
                }

                if (command === "ping") {
                    await conn.sendMessage(from, { text: `*Eliakim MD Active* ⚡\nSpeed: ${Date.now() - m.messageTimestamp * 1000}ms` }, { quoted: m });
                }
            }
        } catch (e) { console.error(e); }
    });

    // ANTI-DELETE (Sent to DM)
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const id = update.update.protocolMessage.key.id;
                const cached = msgCache.get(id);
                if (cached && OWNER_JID) {
                    const sender = jidNormalizedUser(cached.key.participant || cached.key.remoteJid);
                    await conn.sendMessage(OWNER_JID, { text: `📢 *ANTI-DELETE*\n👤 *From:* @${sender.split('@')[0]}`, mentions: [sender] });
                    await conn.sendMessage(OWNER_JID, { forward: cached });
                }
            }
        }
    });

    // CONNECTION UPDATE
    conn.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            const welcome = `
╔══════════════════╗
   *ELIAKIM MD ONLINE* ☠️
╚══════════════════╝
✅ *Bot Connected Successfully!*

🛡️ *Features Active:*
- Always Typing: *ON*
- Anti-Delete: *ON (Sent to DM)*
- Auto-Status: *ON*

_Your bot is ready for use._`.trim();
            await conn.sendMessage(OWNER_JID, { text: welcome });
        }
        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
