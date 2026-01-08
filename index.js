const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    downloadMediaMessage 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const zlib = require('zlib');
const { Boom } = require("@hapi/boom");

// --- CONFIGURATION ---
const SESSION_ID = "PASTE_YOUR_SESSION_ID_HERE"; 
const PREFIX = "!"; 
const messageStorage = {}; 

async function authSession() {
    if (!fs.existsSync('./session')) fs.mkdirSync('./session');
    if (!fs.existsSync('./session/creds.json')) {
        try {
            const base64Data = SESSION_ID.split(';;;')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const jsonString = zlib.gunzipSync(buffer).toString();
            fs.writeFileSync('./session/creds.json', jsonString);
            console.log("✅ Credentials restored.");
        } catch (e) {
            console.log("❌ Invalid Session ID.");
        }
    }
}

async function startBot() {
    await authSession();
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ["Knight-Lite", "Chrome", "3.0"],
        printQRInTerminal: false
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const isGroup = from.endsWith('@g.us');
            const senderJid = m.key.participant || m.key.remoteJid;
            const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";

            // 1. AUTO VIEW STATUS
            if (from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                return;
            }

            // Extract Body Text
            let body = (type === 'conversation') ? m.message.conversation : 
                       (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                       (m.message[type]?.caption) ? m.message[type].caption : "";

            // 2. STORE MESSAGE FOR ANTI-DELETE RECOVERY
            messageStorage[m.key.id] = m;

            // 3. COMMAND HANDLER
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();
                
                // --- PING COMMAND ---
                if (command === "ping") {
                    const start = Date.now();
                    await conn.sendMessage(from, { text: "Testing speed..." }, { quoted: m });
                    const end = Date.now();
                    await conn.sendMessage(from, { 
                        text: `☠️ *Knight-Lite Ultra is Active!*\n\n*Latency:* ${end - start}ms\n*Status:* Online 🚀` 
                    }, { quoted: m });
                }

                // --- !vv COMMAND (REPLY TO VIEW ONCE) ---
                if (command === "vv") {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return await conn.sendMessage(from, { text: "⚠️ Reply to a View Once message with !vv" });

                    const viewOnceMsg = quoted.viewOnceMessageV2 || quoted.viewOnceMessage;
                    if (!viewOnceMsg) return await conn.sendMessage(from, { text: "⚠️ Not a View Once message." });

                    const mediaType = Object.keys(viewOnceMsg.message)[0];
                    const buffer = await downloadMediaMessage(
                        { message: viewOnceMsg.message },
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: conn.updateMediaMessage }
                    );

                    const payload = {};
                    if (mediaType === 'imageMessage') payload.image = buffer;
                    if (mediaType === 'videoMessage') payload.video = buffer;
                    payload.caption = `🔓 *VO Unlocked*\n*From:* @${senderJid.split('@')[0]}`;
                    payload.mentions = [senderJid];

                    await conn.sendMessage(myJid, payload);
                    await conn.sendMessage(from, { text: "✅ Media sent to your DM." });
                }
            }

            // 4. SMART ANTI-LINK (Groups only, Bot Admin only)
            if (isGroup && /(https?:\/\/[^\s]+)/g.test(body)) {
                const groupMetadata = await conn.groupMetadata(from);
                const participants = groupMetadata.participants;
                
                const botParticipant = participants.find(p => p.id.split(':')[0] === conn.user.id.split(':')[0]);
                const senderParticipant = participants.find(p => p.id === senderJid);

                const botIsAdmin = botParticipant?.admin || botParticipant?.isSuperAdmin;
                const senderIsAdmin = senderParticipant?.admin || senderParticipant?.isSuperAdmin;

                // Delete only if Bot is Admin AND Sender is NOT Admin
                if (botIsAdmin && !senderIsAdmin) {
                    await conn.sendMessage(from, { delete: m.key });
                }
            }

        } catch (err) { console.error("Error:", err); }
    });

    // 5. ENHANCED ANTI-DELETE (Reports to DM)
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) { 
                const key = update.key;
                const deletedMsg = messageStorage[key.id];
                const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";

                if (deletedMsg) {
                    const type = getContentType(deletedMsg.message);
                    const name = deletedMsg.pushName || "Unknown";
                    const number = key.participant ? key.participant.split('@')[0] : key.remoteJid.split('@')[0];
                    const chat = key.remoteJid.endsWith('@g.us') ? "Group Chat" : "Private Chat";

                    await conn.sendMessage(myJid, { 
                        text: `🛡️ *DELETED MESSAGE RECOVERY*\n\n*User:* ${name}\n*Number:* ${number}\n*In:* ${chat}`,
                        mentions: [key.participant || key.remoteJid]
                    });

                    if (type === 'conversation' || type === 'extendedTextMessage') {
                        const content = deletedMsg.message.conversation || deletedMsg.message.extendedTextMessage.text;
                        await conn.sendMessage(myJid, { text: `📩 *Content:* ${content}` });
                    } else if (deletedMsg.message[type]) {
                        try {
                            const buffer = await downloadMediaMessage(deletedMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                            const mediaType = type.replace('Message', '');
                            const payload = {};
                            payload[mediaType] = buffer;
                            payload.caption = `📩 *Recovered Media Content*`;
                            await conn.sendMessage(myJid, payload);
                        } catch (e) {
                            await conn.sendMessage(myJid, { text: "⚠️ Media could not be recovered." });
                        }
                    }
                    delete messageStorage[key.id];
                }
            }
        }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";
            console.log('✅ KNIGHT-LITE IS LIVE');
            conn.sendMessage(myJid, { text: "✅ *Knight-Lite Ultra Online*\n\n- !ping (Check speed)\n- !vv (Recover View Once)\n- Anti-Link & Anti-Delete Active" });
        }
    });
}

startBot();
