const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    downloadMediaMessage,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const zlib = require('zlib');
const { Boom } = require("@hapi/boom");

const SESSION_ID = "KEITH;;;..."; // Keep your long ID here
const PREFIX = "!"; 

async function authSession() {
    if (!fs.existsSync('./session')) fs.mkdirSync('./session');
    if (!fs.existsSync('./session/creds.json')) {
        try {
            const base64Data = SESSION_ID.split(';;;')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const jsonString = zlib.gunzipSync(buffer).toString();
            fs.writeFileSync('./session/creds.json', jsonString);
            console.log("✅ Credentials Decoded.");
        } catch (e) { console.log("❌ Session ID Invalid."); }
    }
}

async function startBot() {
    await authSession();
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Knight-Lite", "Chrome", "3.0.0"],
        printQRInTerminal: false,
        // These settings prevent the bot from getting stuck in old history
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            // ONLY process new notifications
            if (chatUpdate.type !== 'notify') return;

            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            
            // --- ADVANCED TEXT EXTRACTION ---
            let body = "";
            if (type === 'conversation') body = m.message.conversation;
            else if (type === 'extendedTextMessage') body = m.message.extendedTextMessage.text;
            else if (type === 'imageMessage' || type === 'videoMessage') body = m.message[type].caption;
            else if (m.message.buttonsResponseMessage) body = m.message.buttonsResponseMessage.selectedButtonId;
            else if (m.message.listResponseMessage) body = m.message.listResponseMessage.singleSelectReply.selectedRowId;
            else if (m.message.templateButtonReplyMessage) body = m.message.templateButtonReplyMessage.selectedId;

            if (!body) return; // Ignore if there is no text/caption

            // DEBUG: See message in console/logs
            console.log(`📩 [NEW MSG] From: ${from} | Content: ${body}`);

            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();

                if (command === "ping") {
                    console.log("🚀 Responding to Ping...");
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is Active!*" }, { quoted: m });
                }
            }

        } catch (err) { console.error("Error:", err); }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed: ${reason}. Reconnecting...`);
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT ONLINE AND READY');
        }
    });
}

startBot();
