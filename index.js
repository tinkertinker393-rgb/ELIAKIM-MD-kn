const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");
const path = require("path");
const zlib = require("zlib");

const SESSION_FOLDER = 'session';
const PREFIX = "!"; 
const SESSION_ID = process.env.SESSION_ID; 
const logger = pino({ level: 'silent' });
const msgCache = new Map();

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
            console.log("✅ Session Restored.");
        } catch (e) { console.log("❌ Session ID error."); }
    }
}

async function startBot() {
    await restoreSession();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const conn = makeWASocket({
        logger: logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ["Knight-Lite", "Chrome", "121.0.0"],
        markOnlineOnConnect: true
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const sender = isGroup ? m.key.participant : from;
            const ownerJid = jidNormalizedUser(conn.user.id);

            // 1. AUTO VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // 2. CACHE FOR ANTIDELETE
            msgCache.set(m.key.id, m);
            if (msgCache.size > 1000) msgCache.delete(msgCache.keys().next().value);

            // 3. ALWAYS TYPING
            if (!m.key.fromMe) await conn.sendPresenceUpdate('composing', from);

            // 4. CONTENT PARSING
            const type = getContentType(m.message);
            const content = type === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const msgType = getContentType(content);
            const body = (msgType === 'conversation') ? content.conversation : 
                         (msgType === 'extendedTextMessage') ? content.extendedTextMessage.text : 
                         (content[msgType]?.caption) ? content[msgType].caption : '';

            // 5. ANTILINK LOGIC
            const containsLink = /(https?:\/\/[^\s]+)/g.test(body);
            if (isGroup && containsLink && !m.key.fromMe) {
                const groupMetadata = await conn.groupMetadata(from);
                const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
                if (!admins.includes(sender)) {
                    if (admins.includes(ownerJid)) {
                        await conn.sendMessage(from, { delete: m.key });
                        await conn.sendMessage(from, { text: `🚫 *ANTILINK:* @${sender.split('@')[0]}, links are forbidden.`, mentions: [sender] });
                    }
                }
            }

            // 6. VIEW-ONCE RETRIEVAL (BUFFER METHOD)
            const isViewOnce = msgType === 'viewOnceMessageV2' || msgType === 'viewOnceMessage';
            if (isViewOnce && !m.key.fromMe) {
                const viewOnceContent = content[msgType].message;
                const mediaType = getContentType(viewOnceContent);
                const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: conn.updateMediaMessage });

                const caption = `📸 *VIEW-ONCE BYPASS*\n\n*From:* @${sender.split('@')[0]}\n*Type:* ${mediaType}`;
                if (mediaType === 'imageMessage') {
                    await conn.sendMessage(ownerJid, { image: buffer, caption, mentions: [sender] });
                } else if (mediaType === 'videoMessage') {
                    await conn.sendMessage(ownerJid, { video: buffer, caption, mentions: [sender] });
                }
            }

            // 7. COMMANDS
            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
                if (command === "ping") {
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is online*" }, { quoted: m });
                }
            }
        } catch (err) { console.error(err); }
    });

    // 8. ANTIDELETE LISTENER
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const deletedId = update.update.protocolMessage.key.id;
                const cachedMsg = msgCache.get(deletedId);
                if (cachedMsg) {
                    const ownerJid = jidNormalizedUser(conn.user.id);
                    const sender = cachedMsg.key.participant || cachedMsg.key.remoteJid;
                    await conn.sendMessage(ownerJid, { text: `🛡️ *DELETED MESSAGE DETECTED*\n*From:* @${sender.split('@')[0]}`, mentions: [sender] });
                    await conn.sendMessage(ownerJid, { forward: cachedMsg }, { quoted: cachedMsg });
                }
            }
        }
    });

    // 9. COOL CONNECTION DASHBOARD
    conn.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            const ownerJid = jidNormalizedUser(conn.user.id);
            const time = new Date().toLocaleTimeString();
            
            const dashboard = "```" + 
                "  ⚔️ KNIGHT-LITE ULTRA ⚔️\n" +
                "  ───────────────────────\n" +
                "  [ SYSTEM STATUS: ONLINE ]\n\n" +
                "  👤 USER: " + conn.user.name + "\n" +
                "  ⏰ TIME: " + time + "\n" +
                "  🛡️ ANTIDELETE: ACTIVE\n" +
                "  📸 VIEWONCE:   BYPASS\n" +
                "  🚫 ANTILINK:   SHIELD ON\n" +
                "  👀 AUTO-VIEW:  ENABLED\n\n" +
                "  ───────────────────────\n" +
                "   K N I G H T - L I T E\n" +
                "  ───────────────────────\n" +
                "  TEST: Type !ping```";
            
            await conn.sendMessage(ownerJid, { text: dashboard });
            console.log('✅ KNIGHT-LITE ULTRA CONNECTED');
        }
        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
