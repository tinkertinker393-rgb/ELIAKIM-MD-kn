const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs-extra");
const { Boom } = require("@hapi/boom");

// --- Configuration ---
const SESSION_ID = process.env.SESSION_ID; 
const prefix = ".";
const botName = "Eliakim MD";
const statusEmojis = ["❤️", "✨", "🔥", "💯", "🙌", "✅", "⚡"];
const msgStore = new Map(); // For Antidelete

async function startEliakim() {
    // 1. Create 'session' folder if it doesn't exist
    if (!fs.existsSync('./session')) {
        fs.mkdirSync('./session');
    }
    
    // 2. Decode Session ID from Secrets into the session folder
    if (SESSION_ID) {
        try {
            const decodedCreds = Buffer.from(SESSION_ID, 'base64').toString('utf-8');
            fs.writeFileSync('./session/creds.json', decodedCreds);
            console.log("🔓 Session folder initialized from Secret.");
        } catch (e) {
            console.error("❌ Failed to decode SESSION_ID. Ensure it is a valid Base64 string.");
        }
    } else if (!fs.existsSync('./session/creds.json')) {
        console.error("❌ No SESSION_ID found in environment and no existing session file.");
        process.exit(1); // Stop if no session is provided
    }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: [botName, "Chrome", "1.0.0"],
        syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Connection lost. Reconnecting...");
                startEliakim();
            } else {
                console.log("❌ Logged out. Please update your SESSION_ID.");
            }
        } else if (connection === "open") {
            console.log(`✅ ${botName} is Live!`);
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            
            await sock.sendMessage(myJid, { 
                text: `*${botName} CONNECTED* 🚀\n\n_Session successfully loaded into /session folder._` 
            });
        }
    });

    sock.ev.on("messages.upsert", async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            const jid = mek.key.remoteJid;

            // --- 1. AUTO VIEW & LIKE STATUS ---
            if (jid === 'status@broadcast') {
                await sock.readMessages([mek.key]);
                const emoji = statusEmojis[Math.floor(Math.random() * statusEmojis.length)];
                await sock.sendMessage(jid, { react: { key: mek.key, text: emoji } }, { 
                    statusJidList: [mek.key.participant, sock.user.id.split(':')[0] + '@s.whatsapp.net'] 
                });
                return;
            }

            // Always Typing
            await sock.sendPresenceUpdate('composing', jid);

            const type = Object.keys(mek.message)[0];
            const body = (type === 'conversation') ? mek.message.conversation : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : (type === 'imageMessage') ? mek.message.imageMessage.caption : (type === 'videoMessage') ? mek.message.videoMessage.caption : '';
            const isCmd = body.startsWith(prefix);
            const command = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : '';

            // --- 2. ANTIDELETE ---
            msgStore.set(mek.key.id, mek);
            if (msgStore.size > 200) msgStore.delete(msgStore.keys().next().value);

            if (type === 'protocolMessage' && mek.message.protocolMessage.type === 0) {
                const key = mek.message.protocolMessage.key;
                const deletedMsg = msgStore.get(key.id);
                if (deletedMsg) {
                    await sock.sendMessage(jid, { text: `🛡️ *${botName} Antidelete* detected a deleted message.` });
                    await sock.copyNForward(jid, deletedMsg, false);
                }
            }

            // --- 3. VIEW ONCE BYPASS ---
            if (type === 'viewOnceMessageV2' || type === 'viewOnceMessage') {
                let view = mek.message.viewOnceMessageV2 || mek.message.viewOnceMessage;
                let msgType = Object.keys(view.message)[0];
                let media = await downloadContentFromMessage(view.message[msgType], msgType.replace('Message', ''));
                let buffer = Buffer.from([]);
                for await (const chunk of media) { buffer = Buffer.concat([buffer, chunk]); }
                await sock.sendMessage(sock.user.id, { [msgType.replace('Message', '')]: buffer, caption: `🛡️ *VV Bypass*` });
            }

            // --- 4. COMMANDS ---
            if (isCmd) {
                switch (command) {
                    case 'ping':
                        await sock.sendMessage(jid, { text: `🚀 Speed: ${Date.now() - mek.messageTimestamp * 1000}ms` });
                        break;
                }
            }
        } catch (err) { console.log(err); }
    });
}

startEliakim();
