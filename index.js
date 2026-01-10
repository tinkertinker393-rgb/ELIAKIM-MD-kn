const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, getContentType, makeCacheableSignalKeyStore, jidNormalizedUser, downloadContentFromMessage } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");

// --- CONFIGURATION ---
const OWNER_NUMBER = "254746404008"; 
const OWNER_JID = OWNER_NUMBER + "@s.whatsapp.net";
const PREFIX = "!"; 
const logger = pino({ level: 'silent' });
const msgCache = new Map();
const startTime = Date.now(); // For ping/uptime

// --- UTILS ---
async function downloadMedia(message) {
    let type = Object.keys(message);
    let m = message[type];
    while (type === 'viewOnceMessageV2' || type === 'viewOnceMessage' || type === 'viewOnceMessageV3') {
        m = m.message;
        type = Object.keys(m);
        m = m[type];
    }
    const stream = await downloadContentFromMessage(m, type.replace('Message', ''));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const conn = makeWASocket({ 
        logger, 
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: ["Eliakim MD", "Chrome", "1.0.0"]
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            await conn.sendMessage(OWNER_JID, { text: "✨ *Eliakim MD Online!*\n\n- Always Typing: ✅\n- Auto Status: ✅\n- Prefix: `!`" });
        }
        if (update.connection === 'close') {
            const shouldReconnect = (update.lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    conn.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || !m.key.remoteJid) return;
            const from = m.key.remoteJid;
            const sender = jidNormalizedUser(m.key.participant || from);
            const isOwner = sender === OWNER_JID;

            // 1. ALWAYS TYPING 
            if (from !== 'status@broadcast') {
                await conn.sendPresenceUpdate('composing', from);
            }

            // 2. AUTO STATUS VIEW & REACTION
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                const emojis = ['🔥', '❤️', '✅', '⚡', '🌟'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                await conn.sendMessage(from, { react: { key: m.key, text: randomEmoji } }, { statusJidList: [sender] });
                return;
            }

            // 3. COMMANDS
            const msgType = getContentType(m.message);
            const content = msgType === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const innerType = getContentType(content);
            const body = (innerType === 'conversation') ? content.conversation : (innerType === 'extendedTextMessage') ? content.extendedTextMessage.text : (content[innerType]?.caption) ? content[innerType].caption : '';

            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
                
                // PING COMMAND
                if (command === "ping") {
                    const timestamp = Date.now();
                    const latency = timestamp - m.messageTimestamp * 1000;
                    await conn.sendMessage(from, { text: `🏓 *Pong!*\nLatency: \`${latency}ms\`` }, { quoted: m });
                }

                // VIEW ONCE RETRIEVE
                if (command === "vv") {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return conn.sendMessage(from, { text: "❌ Reply to a View Once media." });
                    const buffer = await downloadMedia(quoted);
                    const mediaType = Object.keys(quoted).find(k => k.includes('Message')).replace('Message', '');
                    await conn.sendMessage(from, { [mediaType]: buffer, caption: "✅ Decoded" }, { quoted: m });
                }
            }

            // 4. AUTO-DELETE LINKS (Non-owners)
            if (/https?:\/\/[^\s]+/.test(body) && !isOwner) {
                await conn.sendMessage(from, { delete: m.key });
            }

            msgCache.set(m.key.id, m);
        } catch (e) { console.error(e); }
    });
}

startBot();
                                
