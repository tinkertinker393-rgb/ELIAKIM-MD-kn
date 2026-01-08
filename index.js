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

const SESSION_FOLDER = 'session';
const PREFIX = "!"; 
const SESSION_ID = process.env.SESSION_ID; 

// This map stores every message the bot sees.
// If a message is deleted later, we grab it from here.
const msgCache = new Map();

async function restoreSession() {
    await fs.ensureDir(SESSION_FOLDER);
    const credsPath = path.join(SESSION_FOLDER, 'creds.json');
    if (!fs.existsSync(credsPath) && SESSION_ID) {
        try {
            const base64Data = SESSION_ID.includes(';;;') ? SESSION_ID.split(';;;')[1] : SESSION_ID;
            const buffer = Buffer.from(base64Data, 'base64');
            const decompressed = zlib.gunzipSync(buffer);
            await fs.writeFile(credsPath, decompressed);
            console.log("✅ Session Restored.");
        } catch (e) { console.log("❌ SESSION_ID error."); }
    }
}

async function startBot() {
    await restoreSession();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Knight-Lite", "Chrome", "121.0.0"],
        markOnlineOnConnect: true,
    });

    conn.ev.on('creds.update', saveCreds);

    // --- 1. HANDLING NEW MESSAGES ---
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const ownerJid = jidNormalizedUser(conn.user.id);
            const sender = m.key.participant || m.key.remoteJid;

            // AUTO-VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // --- DEEP MESSAGE PARSING ---
            // We dig through layers: Ephemeral -> ViewOnce -> Content
            let messageType = getContentType(m.message);
            let msgContent = m.message;

            if (messageType === 'ephemeralMessage') {
                msgContent = msgContent.ephemeralMessage.message;
                messageType = getContentType(msgContent);
            }

            let isViewOnce = false;
            if (messageType === 'viewOnceMessageV2' || messageType === 'viewOnceMessage') {
                isViewOnce = true;
                msgContent = msgContent[messageType].message;
                messageType = getContentType(msgContent);
            }

            // CACHE FOR ANTI-DELETE: Store message so we can recover it later
            msgCache.set(m.key.id, m);
            if (msgCache.size > 1000) msgCache.delete(msgCache.keys().next().value);

            // ALWAYS TYPING
            if (!m.key.fromMe) await conn.sendPresenceUpdate('composing', from);

            // AUTO-VIEWONCE FORWARDING
            if (isViewOnce && !m.key.fromMe) {
                await conn.sendMessage(ownerJid, { 
                    text: `📸 *VIEW-ONCE DETECTED*\n*From:* @${sender.split('@')[0]}`, 
                    mentions: [sender] 
                });
                await conn.sendMessage(ownerJid, { forward: { message: msgContent, key: m.key } });
            }

            // COMMANDS (Ping)
            const body = (messageType === 'conversation') ? msgContent.conversation : 
                         (messageType === 'extendedTextMessage') ? msgContent.extendedTextMessage.text : 
                         (msgContent[messageType]?.caption) ? msgContent[messageType].caption : '';

            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();
                if (command === "ping") {
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is online*" }, { quoted: m });
                }
            }
        } catch (err) { console.error("Upsert Error:", err); }
    });

    // --- 2. THE ANTI-DELETE LISTENER (Delete for Everyone) ---
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // protocolMessage type 0 = "Delete for Everyone" (Revoke)
            if (update.update.protocolMessage?.type === 0) {
                const deletedMsgId = update.update.protocolMessage.key.id;
                const originalMsg = msgCache.get(deletedMsgId);

                if (originalMsg) {
                    const ownerJid = jidNormalizedUser(conn.user.id);
                    const sender = originalMsg.key.participant || originalMsg.key.remoteJid;

                    await conn.sendMessage(ownerJid, { 
                        text: `🛡️ *DELETED FOR EVERYONE*\n\n*From:* @${sender.split('@')[0]}\n*Chat:* ${originalMsg.key.remoteJid}`, 
                        mentions: [sender] 
                    });

                    // Send the deleted message back to you
                    await conn.sendMessage(ownerJid, { forward: originalMsg });
                    msgCache.delete(deletedMsgId); // Clear it from memory
                }
            }
        }
    });

    conn.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            const ownerJid = jidNormalizedUser(conn.user.id);
            conn.sendMessage(ownerJid, { text: "✅ *KNIGHT-LITE ULTRA CONNECTED*\n\nAntidelete: Active\nView-Once: Active\nStatus-View: Active" });
            console.log('✅ BOT READY');
        }
        if (u.connection === 'close') {
            if (new Boom(u.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        }
    });
}

startBot();
