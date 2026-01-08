const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType 
} = require("@whiskeysockets/baileys");
const pino = require("pino");

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Knight-Lite", "Desktop", "3.0"],
        // FORCE the bot to ignore all previous history
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        // Speed up connection
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
    });

    conn.ev.on('creds.update', saveCreds);

    // This is the event that listens for messages
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        // RAW DEBUG: This MUST show up if the bot sees a message
        console.log("=== EVENT TRIGGERED ===");
        
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            // Log the sender for debugging
            const from = m.key.remoteJid;
            console.log("From:", from);

            // 1. EXTRACT TEXT
            const type = getContentType(m.message);
            let body = "";
            if (type === 'conversation') body = m.message.conversation;
            else if (type === 'extendedTextMessage') body = m.message.extendedTextMessage.text;
            else if (type === 'imageMessage' || type === 'videoMessage') body = m.message[type].caption;
            
            console.log("Text content:", body);

            // 2. SIMPLE COMMAND CHECK (No prefix for testing)
            // Just type "ping" or "!ping"
            if (body.toLowerCase().includes("ping")) {
                console.log("Pong condition met. Sending...");
                await conn.sendMessage(from, { text: "☠️ *Knight-Lite is responding!*" }, { quoted: m });
            }

            // ANTI-DELETE CAPTURE (Background)
            // ... logic can go here later
            
        } catch (err) {
            console.error("Handler Error:", err);
        }
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT IS FULLY LIVE');
            const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            await conn.sendMessage(myId, { text: "✅ Bot is active.\n\nType *ping* (no prefix) to test if I can see you." });
        }
    });
}

startBot();
