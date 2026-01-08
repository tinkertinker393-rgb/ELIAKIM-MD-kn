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

// --- CONFIGURATION ---
const SESSION_ID = "KEITH;;;H4sIAAAAAAAAA5VU2Y6jOBT9F78manZCkEoatgSyEFLZIKN5MGAIFbayDYRq5d9HpLq6WiNNTw1PxrbuPfcs/g7KKiNoiXqgfgc1zlpI0bCkfY2ACvQmSRAGYxBDCoEKqvmVwsWJJ1xesi9apRTLw9H2WjNpeGZGT3P51nKBZtp++gTuY1A3YZ5FvynodKwRrYLzqOsKJ+C5EHP8cractr61CF07bEcjRjuK1Xm3fgL3oSLMcFamVn1BBcIwX6Legxn+GvzCDTDD6PMgVyYSw7qTfhcysuTMWyhMpvVz0h0tAW9oIURfg/864wNvFnN8WrvmprSf3ybPXZg3Gw5KFnVeREOb0DCrKae9wydZWqLYiVFJM9p/mfeD1ZxHoSFtyJy/NPS5FrfTw2XeQHoxkgw2zHNlek2W0FP1NeBv0vHl4Gz2u8tkNytTHJ63WNNl91Wmq2T25kXOaoVSa7rlul+Be/jDK9f/w/vVs8XDbhEG5mlGGYqrgyR7xhUaR46tUmk094Ua+/aIKYKvwccHX3itvLWzer75bgtfnJ4NmNEyNhdXS5/z7iq4eA4fWCfyCR/SBv/W3OnVnx5ssr5NaKG5V2OjrC+uM4fygV7waLWSW+yjaL1cbepNeL2wnZTtjfNrolP+todsQ+kyRoZtHv2pDrW1ac8YvXt6THRFvRMDlbuPAUZpRiiGNKvKYY/nuDGAcbtDEUb0QS9o/AOrGOVWb49CbBeLupXlm8fgJi5PRXAIcsXOdnkpM5frExiDGlcRIgTFdkZohfs1IgSmiAD1z7/GoEQ3+i7c0E7gxiDJMKGHsqnzCsYfqn4cwiiqmpLu+jIyhgXCQGU/txGlWZmSgcemhDi6ZC0yLpASoCYwJ+jnhAijGKgUN+hnao0qHohnrbXrGcoZjEHxECSLgQp4SZyIssiKLKuonPAH+dYNZWFdfysRBWOQv1/jBUGROVlUOEERHjeHg/tPhEPBGFGY5QSowHB2M0VhLctbWgyp5nPNSTUj1cDnRB/WeKeeCm/iduEa3XHaGftQ8OB11zWEeN5ExCvdR5nuOpZxK68P6v9ZBKigsyrPYsxaS6k3X+SxdDHdbvJKWJkWot0nnO7jwPTX69ARDsJryRgX+WVpuY2y4MibpItm0vW0jYq2jnWfM188LBna09AtRm0WoV+bMc/SWZ71nnOAJ32xGnldOedQsQ1Mvmwro9Cym/ii7/z5wi2D6KQv1lFbFLNtRkaaZgZxFNnCFO2PfV+GofKq5+k6Mbfvpn2EJv/xWGUPOw1aDb9Jhh7ZL+Gg4H9r9w58sBh7H/9S48dr8i+J1MNYGVnGfktmSaRd+ekbX1tkhVfm22i07LujUKX7na6Rs7QA9/tfY1DnkCYVLoAKYBnjKovBGOCqGTzrlEn1m2aG7jjmNjWGyXNIqPaZg31WIEJhUQOVm8gTRZ6wrPh+y8NVbUNyASrwTldJHzzda3W9o5B+pApow+dUFNz/BtpFT/1xBwAA"; 
const PREFIX = "!"; 
const messageStorage = new Map(); // More efficient storage

async function authSession() {
    if (!fs.existsSync('./session')) fs.mkdirSync('./session');
    if (!fs.existsSync('./session/creds.json')) {
        try {
            const base64Data = SESSION_ID.split(';;;')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const jsonString = zlib.gunzipSync(buffer).toString();
            fs.writeFileSync('./session/creds.json', jsonString);
            console.log("✅ Credentials created.");
        } catch (e) { console.log("❌ Session ID Error."); }
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
        browser: ["Knight-Lite", "Chrome", "20.0.0"],
        // FORCE IGNORE OLD MESSAGES
        shouldSyncHistoryMessage: () => false, 
        syncFullHistory: false,
        linkPreviewImageThumbnailWidth: 192,
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";

            // Save for Anti-Delete (Crucial: bot must "see" it first)
            messageStorage.set(m.key.id, m);

            // AUTO-VIEW STATUS
            if (from === 'status@broadcast') return await conn.readMessages([m.key]);

            // Extract Text
            let body = (type === 'conversation') ? m.message.conversation : 
                       (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                       (m.message[type]?.caption) ? m.message[type].caption : "";

            // LOG ALL INCOMING (Debug)
            console.log(`[MSG] From: ${from} | Text: ${body.substring(0, 20)}`);

            // Commands
            if (body.startsWith(PREFIX)) {
                const command = body.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
                
                if (command === "ping") {
                    console.log("Processing Ping...");
                    await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra is Online!*" }, { quoted: m });
                }

                if (command === "vv") {
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quoted) return;
                    const viewOnceMsg = quoted.viewOnceMessageV2 || quoted.viewOnceMessage;
                    if (!viewOnceMsg) return;

                    const mediaType = Object.keys(viewOnceMsg.message)[0];
                    const buffer = await downloadMediaMessage({ message: viewOnceMsg.message }, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: conn.updateMediaMessage });
                    const payload = {};
                    if (mediaType === 'imageMessage') payload.image = buffer;
                    else if (mediaType === 'videoMessage') payload.video = buffer;
                    payload.caption = "🔓 *View Once Recovered*";
                    await conn.sendMessage(myJid, payload);
                }
            }

            // ANTI-LINK (Simple)
            if (from.endsWith('@g.us') && /(https?:\/\/[^\s]+)/g.test(body) && !m.key.fromMe) {
                const groupMetadata = await conn.groupMetadata(from);
                const bot = groupMetadata.participants.find(p => p.id.split(':')[0] === conn.user.id.split(':')[0]);
                if (bot?.admin) await conn.sendMessage(from, { delete: m.key });
            }

        } catch (err) { console.error("Upsert Error:", err); }
    });

    // ANTI-DELETE
    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) { 
                console.log("Deletion detected!");
                const deletedMsg = messageStorage.get(update.key.id);
                if (deletedMsg) {
                    const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";
                    const sender = update.key.participant || update.key.remoteJid;
                    await conn.sendMessage(myJid, { text: `🛡️ *DELETED:* @${sender.split('@')[0]} deleted a message.`, mentions: [sender] });
                    // Forward text if it was a text message
                    const type = getContentType(deletedMsg.message);
                    if (type === 'conversation' || type === 'extendedTextMessage') {
                        const txt = deletedMsg.message.conversation || deletedMsg.message.extendedTextMessage.text;
                        await conn.sendMessage(myJid, { text: `📩 *Content:* ${txt}` });
                    }
                }
            }
        }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed: ${reason}. Reconnecting...`);
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT ONLINE AND READY');
            const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";
            conn.sendMessage(myJid, { text: "✅ *Knight-Lite Ultra Ready.*\nIf I don't respond to !ping instantly, wait 1 minute for sync to finish." });
        }
    });
}

startBot();
