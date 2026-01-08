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

const msgCache = new Map();

async function restoreSession() {
    await fs.ensureDir(SESSION_FOLDER);
    const credsPath = path.join(SESSION_FOLDER, 'creds.json');
    if (!fs.existsSync(credsPath) && SESSION_ID) {
        try {
            const base64Data = SESSION_ID.split(';;;')[1] || SESSION_ID;
            const buffer = Buffer.from(base64Data, 'base64');
            const decompressed = zlib.gunzipSync(buffer);
            await fs.writeFile(credsPath, decompressed);
            console.log("✅ Credentials Decoded from SESSION_ID.");
        } catch (e) { 
            console.log("❌ SESSION_ID invalid.");
        }
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
        generateHighQualityLinkPreview: true
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const sender = isGroup ? m.key.participant : from;
            const ownerJid = jidNormalizedUser(conn.user.id);

            // 1. AUTO VIEW STATUS (Fixed)
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                console.log(` Viewed status from: ${m.pushName || sender.split('@')[0]}`);
                return;
            }

            // Cache for Antidelete (Stores the actual message object)
            msgCache.set(m.key.id, m);
            if (msgCache.size > 1000) msgCache.delete(msgCache.keys().next().value); // Prevent memory leak

            // 2. ALWAYS TYPING
            if (!m.key.fromMe) await conn.sendPresenceUpdate('composing', from);

            // Helper to get actual message content (Handles Ephemeral/ViewOnce wrappers)
            const msgType = getContentType(m.message);
            const content = msgType === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const type = getContentType(content);
            
            const body = (type === 'conversation') ? content.conversation : 
                         (type === 'extendedTextMessage') ? content.extendedTextMessage.text : 
                         (content[type]?.caption) ? content[type].caption : '';

            // 3. AUTO VIEW-ONCE REDIRECT (Fixed)
            const isViewOnce = type === 'viewOnceMessage' || type === 'viewOnceMessageV2';
            if (isViewOnce && !m.key.fromMe) {
                const viewOnceContent = content[type].message;
                const vvType = getContentType(viewOnceContent);
                
                await conn.sendMessage(ownerJid, { 
                    text: `📸 *VIEW-ONCE DETECTED*\n\n*From:* @${sender.split('@')[0]}\n*Type:* ${vvType}`, 
                    mentions: [sender] 
                });
                
                // Forward the secret content
                await conn.sendMessage(ownerJid, { forward: { message: viewOnceContent, key: m.key } }, { quoted: m });
            }

            // 4. COMMANDS
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();

                if (command === "ping") {
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is online*" }, { quoted: m });
                }
            }
        } catch (err) { console.error("Error in upsert:", err); }
    });

    // 5. ANTIDELETE LISTENER (Fixed)
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage && update.update.protocolMessage.type === 0) { // type 0 is REVOKE (Delete)
                const deletedKey = update.update.protocolMessage.key;
                const cachedMsg = msgCache.get(deletedKey.id);

                if (cachedMsg) {
                    const ownerJid = jidNormalizedUser(conn.user.id);
                    const sender = cachedMsg.key.participant || cachedMsg.key.remoteJid;
                    
                    await conn.sendMessage(ownerJid, { 
                        text: `🛡️ *DELETED MESSAGE DETECTED*\n\n*From:* @${sender.split('@')[0]}\n*Chat:* ${cachedMsg.key.remoteJid}`, 
                        mentions: [sender] 
                    });
                    
                    // Forward the cached message back to you
                    await conn.sendMessage(ownerJid, { forward: cachedMsg }, { quoted: cachedMsg });
                }
            }
        }
    });

    // 6. STARTUP DM
    conn.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            const ownerJid = jidNormalizedUser(conn.user.id);
            const digitalMsg = "```" + 
                "╔════════════════════════╗\n" +
                "║   KNIGHT-LITE ULTRA    ║\n" +
                "║       CONNECTED        ║\n" +
                "╚════════════════════════╝\n\n" +
                "STATUS: ACTIVE ✅\n" +
                "TEST: Type !ping\n\n" +
                "ANTIDELETE: ENABLED 🛡️\n" +
                "VIEWONCE: DM ENABLED 📸\n" +
                "AUTO-STATUS: ACTIVE 👀```";
            await conn.sendMessage(ownerJid, { text: digitalMsg });
            console.log('✅ BOT READY');
        }
        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
