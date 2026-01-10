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
        } catch (e) { console.error("❌ Session Error"); }
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
        browser: [botName, "MacOS", "3.0.0"],
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log(`✅ ${botName} IS ONLINE`);

            // --- COOL CONNECTED MESSAGE ---
            const connectedMsg = `
┏━━━━━━━━━━━━━━┓
┃  ⚡ *${botName} IS LIVE* ⚡
┗━━━━━━━━━━━━━━┛

✨ *System Status:* Online
👤 *Owner:* ${OWNER_NUMBER}
⚙️ *Prefix:* [ ${PREFIX} ]
🛡️ *Mode:* Public

*🚀 ACTIVE MODULES:*
   ├ 🛡️ Antidelete Active
   ├ 👁️ ViewOnce Bypass
   ├ ⌨️ Auto-Typing ON
   ├ 📸 Auto-Status View
   └ 🎭 Auto-Status React

_“Privacy is not an option, it's a priority.”_
__________________________
*Powered by Eliakim MD*`.trim();

            await sock.sendMessage(OWNER_JID, { 
                text: connectedMsg,
                contextInfo: {
                    externalAdReply: {
                        title: `${botName} CONNECTED`,
                        body: "Multi-Device WhatsApp Bot",
                        thumbnailUrl: "https://telegra.ph/file/dcce2ddee667597774274.jpg", // Optional thumbnail
                        sourceUrl: "https://github.com/",
                        mediaType: 1,
                        renderLargerThumbnail: true
                    }
                }
            });
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

            // Always Typing
            if (from !== 'status@broadcast') {
                await sock.sendPresenceUpdate('composing', from);
            }

            msgCache.set(m.key.id, m);

            // Auto Status View/React
            if (from === 'status@broadcast') {
                await sock.readMessages([m.key]);
                await sock.sendMessage(from, { react: { key: m.key, text: '🔥' } }, { statusJidList: [m.key.participant, botNumber] });
                return;
            }

            const type = getContentType(m.message);
            const body = (type === 'conversation') ? m.message.conversation : (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : '';
            
            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
                if (command === "ping") {
                    await sock.sendMessage(from, { text: `*Pong!* ⚡ ${Date.now() - m.messageTimestamp * 1000}ms` }, { quoted: m });
                }
            }
        } catch (e) { console.error(e); }
    });

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
