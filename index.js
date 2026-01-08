const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType 
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const prefix = "!"; 
const msgStore = new Map(); 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        // Increased log level slightly to see connection issues, but kept it clean
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Knight-Lite", "Chrome", "3.0"],
        // This stops the bot from getting stuck processing old messages
        shouldSyncHistoryMessage: () => false 
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            
            // --- DIAGNOSTIC LOG ---
            // This will print every single message the bot sees to your GitHub Logs
            console.log(`📩 NEW MESSAGE FROM: ${from}`);

            // 1. EXTRACT TEXT (Simplified)
            const type = getContentType(m.message);
            let body = "";
            if (type === 'conversation') body = m.message.conversation;
            else if (type === 'extendedTextMessage') body = m.message.extendedTextMessage.text;
            else if (type === 'imageMessage' || type === 'videoMessage') body = m.message[type].caption;

            console.log(`📝 MESSAGE TYPE: ${type} | CONTENT: "${body}"`);

            if (!body) return;

            // 2. CHECK COMMAND
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().toLowerCase() : null;

            if (isCmd) {
                console.log(`🚀 COMMAND DETECTED: ${command}`);

                if (command === "ping") {
                    console.log("Attempting to send Pong...");
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Pong!*" }, { quoted: m });
                    console.log("Pong sent successfully!");
                }
                
                if (command === "vv") {
                    // Logic for vv... (omitted for brevity)
                }
            }

            // Always store for Anti-Delete
            msgStore.set(m.key.id, m);
        } catch (err) {
            console.error("❌ ERROR IN MESSAGE HANDLER:", err);
        }
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            console.log(`📡 Connection closed. Reason: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT IS ONLINE AND READY');
            const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            await conn.sendMessage(myId, { text: "☠️ *Knight-Lite is Live!*\n\nTest it by typing `!ping` right here." });
        }
    });
}

startBot();
