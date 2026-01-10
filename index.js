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

// --- CONFIGURATION ---
const SESSION_FOLDER = './session'; 
const SESSION_ID = process.env.SESSION_ID; 
const OWNER_NUMBER = "254746404008"; 
const OWNER_JID = OWNER_NUMBER + "@s.whatsapp.net";
const PREFIX = ".";
const botName = "ELIAKIM MD";
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
            console.log("✅ Credentials restored to ./session/creds.json");
        } catch (e) { console.error("❌ Session Error:", e.message); }
    }
}

async function startEliakim() {
    await restoreSession();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const sock = makeWASocket({
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: [botName, "Chrome", "1.0.0"],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        // Added to prevent some common cache errors
        getMessage: async (key) => { return { conversation: 'Eliakim MD' } }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log(`✅ ${botName} IS ONLINE`);

            // Small delay to ensure the socket internal cache is ready
            setTimeout(async () => {
                const connectedMsg = `
┏━━━━━━━━━━━━━━┓
┃  ⚡ *${botName} IS LIVE* ⚡
┗━━━━━━━━━━━━━━┛
✨ *System Status:* Online
👤 *Owner:* ${OWNER_NUMBER}
⚙️ *Prefix:* [ ${PREFIX} ]
🛡️ *Mode:* Public

*🚀 ACTIVE MODULES:*
   ├ 🛡️ Antidelete: *Active*
   ├ 👁️ ViewOnce: *Bypass*
   ├ ⌨️ Auto-Typing: *ON*
   ├ 📸 Status View: *ON*
   └ 🎭 Status React: *ON*

_“Power and Privacy in one Bot.”_`.trim();

                try {
                    await sock.sendMessage(OWNER_JID, { text: connectedMsg });
                } catch (e) { console.log("Error sending welcome message:", e.message); }
            }, 3000);
        }

        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startEliakim();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || !m.key.remoteJid) return;

            const from = m.key.remoteJid;
            const botNumber = sock.user ? jidNormalizedUser(sock.user.id) : null;

            // 1. ALWAYS TYPING
            if (from !== 'status@broadcast') {
                await sock.sendPresenceUpdate('composing', from);
            }

            // 2. CACHE
            msgCache.set(m.key.id, m);
            if (msgCache.size > 500) msgCache.delete(msgCache.keys().next().value);

            // 3. AUTO STATUS (Fixed EKEYTYPE here)
            if (from === 'status@broadcast') {
                await sock.readMessages([m.key]);
                // SAFETY: Filter out undefined values from the JID list
                const jidList = [m.key.participant, botNumber].filter(Boolean);
                
                if (jidList.length > 0) {
                    await sock.sendMessage(from, 
                        { react: { key: m.key, text: '❤️' } }, 
                        { statusJidList: jidList }
                    );
                }
                return;
            }

            // 4. COMMANDS
            const type = getContentType(m.message);
            const body = (type === 'conversation') ? m.message.conversation : (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : '';
            
            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
                if (command === "ping") {
                    await sock.sendMessage(from, { text: `🚀 *${botName} Speed:* ${Date.now() - m.messageTimestamp * 1000}ms` }, { quoted: m });
                }
            }
        } catch (e) { console.error("Error in messages.upsert:", e.message); }
    });

    // 5. ANTI-DELETE
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const id = update.update.protocolMessage.key.id;
                const cached = msgCache.get(id);
                if (cached) {
                    const sender = jidNormalizedUser(cached.key.participant || cached.key.remoteJid);
                    await sock.sendMessage(OWNER_JID, { text: `🛡️ *ANTIDELETE* from @${sender.split('@')[0]}`, mentions: [sender] });
                    await sock.copyNForward(OWNER_JID, cached, true);
                }
            }
        }
    });
}

startEliakim();
