const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    disconnectReason, 
    getContentType 
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const prefix = "☠️";
const msgStore = new Map(); 
let lastViewOnce = null;    

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: true,
        browser: ["☠️ Knight-Lite", "Chrome", "3.0"],
        generateHighQualityLinkPreview: true
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
            
            const body = (type === 'conversation') ? m.message.conversation : 
                         (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                         (type === 'imageMessage' || type === 'videoMessage') ? m.message[type].caption : '';

            // 1. AUTO VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // 2. COMMAND: ☠️ping
            if (body === `${prefix}ping`) {
                const start = Date.now();
                await conn.sendMessage(from, { text: "☠️ *Pinging...*" });
                const end = Date.now();
                await conn.sendMessage(from, { text: `☠️ *Pong!* \n\n*Latency:* ${end - start}ms` }, { quoted: m });
            }

            // 3. CAPTURE VIEW ONCE (All types: Image, Video, Voice)
            const vOnce = m.message?.viewOnceMessageV2 || m.message?.viewOnceMessageV2Extension || m.message?.viewOnceMessage;
            if (vOnce) {
                lastViewOnce = m;
                console.log("📸 ViewOnce Captured!");
            }

            // 4. COMMAND: ☠️vv (Download View Once)
            if (body === `${prefix}vv` && m.key.fromMe) {
                if (!lastViewOnce) return await conn.sendMessage(from, { text: "_No View Once found!_" });
                
                await conn.sendMessage(myId, { forward: lastViewOnce, force: true }, { quoted: m });
                await conn.sendMessage(from, { text: "✅ _View Once forwarded to your DM._" });
            }

            // 5. ANTI-LINK (Delete links in groups from others)
            if (from.endsWith('@g.us') && body.match(/chat.whatsapp.com|http/gi) && !m.key.fromMe) {
                await conn.sendMessage(from, { delete: m.key });
            }

            // 6. CACHE FOR ANTI-DELETE (Stores any message type)
            msgStore.set(m.key.id, m);
            if (msgStore.size > 2000) msgStore.clear();

        } catch (err) { console.error("Error in handler:", err); }
    });

    // 7. ANTI-DELETE (Text & Media everywhere -> Sent to your DM)
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) {
                const deletedMsg = msgStore.get(update.key.id);
                if (deletedMsg) {
                    const myId = conn.user.id.split(':')[0] + '@s.whatsapp.net';
                    const sender = deletedMsg.key.participant || deletedMsg.key.remoteJid;
                    
                    await conn.sendMessage(myId, { 
                        text: `⚠️ *ANTI-DELETE DETECTED*\n\n*From:* @${sender.split('@')[0]}\n*Chat:* ${update.key.remoteJid.endsWith('@g.us') ? "Group" : "Private"}`,
                        mentions: [sender]
                    });
                    
                    // Forward the actual deleted message
                    await conn.sendMessage(myId, { forward: deletedMsg }, { quoted: deletedMsg });
                }
            }
        }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== disconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('☠️ Knight-Lite Ultra is Live!');
        }
    });
}

startBot();