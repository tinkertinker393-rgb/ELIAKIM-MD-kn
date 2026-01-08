const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    getContentType,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs-extra");
const path = require("path");
const zlib = require("zlib");

const SESSION_FOLDER = 'session';
const PREFIX = "!";
const SESSION_ID = process.env.SESSION_ID;
const logger = pino({ level: 'silent' });
const msgCache = new Map();

// Feature toggles
const features = {
    antilink: true,
    antidelete: true,
    autoview: true
};

// Pretty logger
function logEvent(type, details) {
    const time = new Date().toLocaleTimeString();
    console.log(
        `\n──────────────────────────────\n` +
        `⏰ ${time}\n` +
        `📌 EVENT: ${type}\n` +
        `🔎 DETAILS: ${details}\n` +
        `──────────────────────────────\n`
    );
}

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
            console.log("✅ Session Restored.");
        } catch (e) { console.log("❌ Session ID error."); }
    }
}

async function startBot() {
    await restoreSession();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const conn = makeWASocket({
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ["Knight-Lite", "Chrome", "121.0.0"],
        markOnlineOnConnect: true
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const sender = jidNormalizedUser(isGroup ? m.key.participant : from);
            const ownerJid = jidNormalizedUser(conn.user.id);

            // Log incoming message
            const type = getContentType(m.message);
            const content = type === 'ephemeralMessage' ? m.message.ephemeralMessage.message : m.message;
            const msgType = getContentType(content);
            const body = (msgType === 'conversation') ? content.conversation :
                         (msgType === 'extendedTextMessage') ? content.extendedTextMessage.text :
                         (content[msgType]?.caption) ? content[msgType].caption : '';

            console.log(`💬 Message from ${sender} (${isGroup ? "Group" : "Private"}): ${body}`);

            // 1. AUTO VIEW STATUS
            if (features.autoview && from === 'status@broadcast') {
                await conn.readMessages([m.key]);
                logEvent("AUTOVIEW", `Viewed status from ${sender}`);
                return;
            }

            // 2. CACHE FOR ANTIDELETE
            msgCache.set(m.key.id, m);
            if (msgCache.size > 1000) msgCache.delete(msgCache.keys().next().value);

            // 3. ALWAYS TYPING
            if (!m.key.fromMe) await conn.sendPresenceUpdate('composing', from);

            // 4. ANTILINK LOGIC
            const containsLink = /(https?:\/\/[^\s]+)/g.test(body);
            if (features.antilink && isGroup && containsLink && !m.key.fromMe) {
                try {
                    const groupMetadata = await conn.groupMetadata(from);
                    const admins = groupMetadata.participants
                        .filter(p => p.admin !== null)
                        .map(p => jidNormalizedUser(p.id));

                    if (!admins.includes(sender)) {
                        if (admins.includes(ownerJid)) {
                            await conn.sendMessage(from, { delete: m.key });
                            await conn.sendMessage(from, {
                                text: `🚫 *ANTILINK:* @${sender.split('@')[0]}, links are forbidden.`,
                                mentions: [sender]
                            });
                            logEvent("ANTILINK", `Blocked link from ${sender} in ${from}`);
                        }
                    }
                } catch (err) {
                    console.error("Antilink error:", err);
                }
            }

            // 5. COMMANDS
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args[0].toLowerCase();
                console.log(`⚔️ Command: ${command} from ${sender}`);

                switch (command) {
                    case "ping":
                        await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is online*" }, { quoted: m });
                        break;

                    case "antilink":
                        if (args[1] === "on") features.antilink = true;
                        if (args[1] === "off") features.antilink = false;
                        await conn.sendMessage(from, { text: `🚫 Antilink is now *${features.antilink ? "ON" : "OFF"}*` }, { quoted: m });
                        break;

                    case "antidelete":
                        if (args[1] === "on") features.antidelete = true;
                        if (args[1] === "off") features.antidelete = false;
                        await conn.sendMessage(from, { text: `🛡️ Antidelete is now *${features.antidelete ? "ON" : "OFF"}*` }, { quoted: m });
                        break;

                    case "autoview":
                        if (args[1] === "on") features.autoview = true;
                        if (args[1] === "off") features.autoview = false;
                        await conn.sendMessage(from, { text: `👀 Auto-view status is now *${features.autoview ? "ON" : "OFF"}*` }, { quoted: m });
                        break;

                    case "vv":
                        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                        const quotedSender = m.message?.extendedTextMessage?.contextInfo?.participant;

                        if (!quoted) break;

                        const qType = getContentType(quoted);
                        if (qType === 'viewOnceMessageV2' || qType === 'viewOnceMessage') {
                            const viewOnceContent = quoted[qType].message;
                            const mediaType = getContentType(viewOnceContent);

                            try {
                                const buffer = await downloadMediaMessage(
                                    { message: viewOnceContent },
                                    'buffer',
                                    {},
                                    { logger, reuploadRequest: conn.updateMediaMessage }
                                );

                                const caption = `📸 *VIEW-ONCE SAVED*\n\n*From:* @${quotedSender.split('@')[0]}\n*Type:* ${mediaType}`;
                                if (mediaType === 'imageMessage') {
                                    await conn.sendMessage(ownerJid, { image: buffer, caption, mentions: [quotedSender] });
                                } else if (mediaType === 'videoMessage') {
                                    await conn.sendMessage(ownerJid, { video: buffer, caption, mentions: [quotedSender] });
                                }
                                logEvent("VIEW-ONCE", `Saved view-once from ${quotedSender} → sent to owner DM`);
                            } catch (err) {
                                console.error("VV command error:", err);
                            }
                        }
                        break;

                    default:
                        await conn.sendMessage(from, { text: "❓ Unknown command. Type !help for options." }, { quoted: m });
                }
            }
        } catch (err) { console.error(err); }
    });

    // ANTIDELETE LISTENER
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (features.antidelete && update.update.protocolMessage?.type === 0) {
                const deletedId = update.update.protocolMessage.key.id;
                const cachedMsg = msgCache.get(deletedId);
                if (cachedMsg) {
                    const ownerJid = jidNormalizedUser(conn.user.id);
                    const sender = jidNormalizedUser(cachedMsg.key.participant || cachedMsg.key.remoteJid);
                    await conn.sendMessage(ownerJid, {
                        text: `🛡️ *DELETED MESSAGE DETECTED*\n*From:* @${sender.split('@')[0]}`,
                        mentions: [sender]
                    });
                    await conn.sendMessage(ownerJid, { forward: cachedMsg }, { quoted: cachedMsg });
                    logEvent("ANTIDELETE", `Recovered deleted message from ${sender} → sent to owner DM`);
                }
            }
        }
    });

    // CONNECTION DASHBOARD
    conn.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            const ownerJid = jidNormalizedUser(conn.user.id);
            const time = new Date().toLocaleTimeString();

            const dashboard = "```" +
                "  ⚔️ KNIGHT-LITE ULTRA ⚔️\n" +
                "  ───────────────────────\n" +
                "  [ SYSTEM STATUS: ONLINE ]\n\n" +
                "  👤 USER: " + conn.user.name + "\n" +
                "  ⏰ TIME: " + time + "\n" +
                `  🛡️ ANTIDELETE: ${features.antidelete ? "ACTIVE" : "OFF"}\n` +
                `  📸 VIEWONCE:   MANUAL (!vv)\n` +
                `  🚫 ANTILINK:   ${features.antilink ? "SHIELD ON" : "OFF"}\n` +
                `  👀 AUTO-VIEW:  ${features.autoview ? "ENABLED" : "OFF"}\n\n` +
                "  ───────────────────────\n" +
                "   K N I G H T - L I T E\n" +
                "  ───────────────────────\n" +
                "  TEST: Type !ping```";

            await conn.sendMessage(ownerJid, { text: dashboard });
            console.log('✅ KNIGHT-LITE ULTRA CONNECTED');
        }
        if (connection === 'close') {
            const shouldReconnect = (new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) startBot();
        }
    });
}

startBot();
