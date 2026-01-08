const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    makeCacheableSignalKeyStore
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
    
    // Only restore from SESSION_ID if local creds don't exist
    if (!fs.existsSync(credsPath) && SESSION_ID) {
        try {
            const base64Data = SESSION_ID.split(';;;')[1];
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
        shouldSyncHistoryMessage: () => false
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const ownerJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';

            // 1. AUTO VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // Cache for Antidelete
            msgCache.set(m.key.id, m);
            setTimeout(() => msgCache.delete(m.key.id), 600000);

            // 2. ALWAYS TYPING (Only for others to save resources)
            if (!m.key.fromMe) await conn.sendPresenceUpdate('composing', from);

            const type = getContentType(m.message);
            const body = (type === 'conversation') ? m.message.conversation : (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : (m.message[type]?.caption) ? m.message[type].caption : '';

            // 3. AUTO VV REDIRECT TO DM
            const vv = m.message.viewOnceMessageV2?.message || m.message.viewOnceMessage?.message;
            if (vv && !m.key.fromMe) {
                await conn.sendMessage(ownerJid, { text: `📸 *VV DETECTED*\nFrom: @${(m.key.participant || from).split('@')[0]}`, mentions: [m.key.participant || from] });
                await conn.sendMessage(ownerJid, { forward: { message: vv, key: m.key } });
            }

            // 4. COMMANDS (Allows testing !ping from your own phone)
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();

                if (command === "ping") {
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is online*" }, { quoted: m });
                }
            }
        } catch (err) { console.error(err); }
    });

    // 5. ANTIDELETE LISTENER
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 3) {
                const cached = msgCache.get(update.update.protocolMessage.key.id);
                if (cached) {
                    const ownerJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                    const sender = cached.key.participant || cached.key.remoteJid;
                    await conn.sendMessage(ownerJid, { text: `🛡️ *DELETED MSG*\nFrom: @${sender.split('@')[0]}`, mentions: [sender] });
                    await conn.sendMessage(ownerJid, { forward: cached });
                }
            }
        }
    });

    // 6. STARTUP DM
    conn.ev.on('connection.update', async (u) => {
        if (u.connection === 'open') {
            const ownerJid = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            const digitalMsg = "```" + 
                "╔════════════════════════╗\n" +
                "║   KNIGHT-LITE ULTRA    ║\n" +
                "║       CONNECTED        ║\n" +
                "╚════════════════════════╝\n\n" +
                "STATUS: ACTIVE ✅\n" +
                "TEST: Type !ping\n\n" +
                "ANTIDELETE: DM ENABLED\n" +
                "VIEWONCE: DM ENABLED\n" +
                "AUTO-STATUS: ACTIVE```";
            await conn.sendMessage(ownerJid, { text: digitalMsg });
            console.log('✅ BOT READY');
        }
        if (u.connection === 'close') {
            if (new Boom(u.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
        }
    });
}

startBot();
