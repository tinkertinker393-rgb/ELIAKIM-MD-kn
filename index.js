const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType 
} = require("@whiskeysockets/baileys");
const pino = require("pino");

// --- SETTINGS ---
const prefix = "!"; 
const msgStore = new Map(); 
let lastViewOnce = null;    

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["Knight-Lite", "Chrome", "3.0"],
        syncFullHistory: true 
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            
            const msgText = (type === 'conversation') ? m.message.conversation : 
                            (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                            (type === 'imageMessage' || type === 'videoMessage') ? m.message[type].caption : '';

            const body = msgText.trim();
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : null;

            // 1. AUTO VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // --- COMMANDS ---

            if (command === "ping") {
                const start = Date.now();
                await conn.sendMessage(from, { text: "🚀 *Knight-Lite is Active...*" }, { quoted: m });
                const end = Date.now();
                await conn.sendMessage(from, { text: `✅ *Pong!* \n\n*Latency:* ${end - start}ms` }, { quoted: m });
            }

            if (command === "vv") {
                if (!m.key.fromMe) return; 
                if (!lastViewOnce) return await conn.sendMessage(from, { text: "❌ _No View-Once message found._" });
                await conn.sendMessage(myId, { forward: lastViewOnce }, { quoted: m });
                await conn.sendMessage(from, { text: "📬 _Forwarded to your Private Chat._" });
            }

            // --- AUTOMATIONS ---

            const vOnce = m.message?.viewOnceMessageV2 || m.message?.viewOnceMessageV2Extension || m.message?.viewOnceMessage;
            if (vOnce) {
                lastViewOnce = m;
            }

            if (from.endsWith('@g.us') && body.match(/chat.whatsapp.com|http/gi) && !m.key.fromMe) {
                try {
                    const groupMetadata = await conn.groupMetadata(from);
                    const isBotAdmin = groupMetadata.participants.find(p => p.id === myId)?.admin;
                    if (isBotAdmin) await conn.sendMessage(from, { delete: m.key });
                } catch (e) {}
            }

            msgStore.set(m.key.id, m);
            if (msgStore.size > 500) msgStore.delete(msgStore.keys().next().value);

        } catch (err) { console.error("Error in handler:", err); }
    });

    // --- ANTI-DELETE ---
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const deletedMsg = msgStore.get(update.key.id);
                if (deletedMsg) {
                    const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                    const sender = (deletedMsg.key.participant || deletedMsg.key.remoteJid).split('@')[0];
                    await conn.sendMessage(myId, { 
                        text: `⚠️ *ANTI-DELETE DETECTED*\n\n*User:* @${sender}\n*Chat:* ${update.key.remoteJid.endsWith('@g.us') ? "Group" : "Private"}`,
                        mentions: [deletedMsg.key.participant || deletedMsg.key.remoteJid]
                    });
                    await conn.sendMessage(myId, { forward: deletedMsg });
                }
            }
        }
    });

    // --- CONNECTION UPDATE (Notification Added Here) ---
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldRestart = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldRestart) startBot();
        } else if (connection === 'open') {
            console.log('✅ Knight-Lite is Online!');

            // SEND NOTIFICATION TO YOUR DM
            const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            const statusMessage = `☠️ *Knight-Lite Ultra Connected!*\n\n` +
                                 `📅 *Date:* ${new Date().toLocaleString()}\n` +
                                 `🛠 *Prefix:* ${prefix}\n` +
                                 `🔄 *Status:* Running Nonstop\n\n` +
                                 `_Bot is now monitoring messages and anti-delete is active._`;
            
            await conn.sendMessage(myId, { text: statusMessage });
        }
    });
}

startBot();
