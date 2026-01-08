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
const SESSION_ID = "KEITH;;;H4sIAAAAAAAAA5VU2Y6jOBT9F78manZCkEoatgSyEFLZIKN5MGAIFbayDYRq5d9HpLq6WiNNTw1PxrbuPfcs/g7KKiNoiXqgfgc1zlpI0bCkfY2ACvQmSRAGYxBDCoEKqvmVwsWJJ1xesi9apRTLw9H2WjNpeGZGT3P51nKBZtp++gTuY1A3YZ5FvynodKwRrYLzqOsKJ+C5EHP8cractr61CF07bEcjRjuK1Xm3fgL3oSLMcFamVn1BBcIwX6Legxn+GvzCDTDD6PMgVyYSw7qTfhcysuTMWyhMpvVz0h0tAW9oIURfg/864wNvFnN8WrvmprSf3ybPXZg3Gw5KFnVeREOb0DCrKae9wydZWqLYiVFJM9p/mfeD1ZxHoSFtyJy/NPS5FrfTw2XeQHoxkgw2zHNlek2W0FP1NeBv0vHl4Gz2u8tkNytTHJ63WNNl91Wmq2T25kXOaoVSa7rlul+Be/jDK9f/w/vVs8XDbhEG5mlGGYqrgyR7xhUaR46tUmk094Ua+/aIKYKvwccHX3itvLWzer75bgtfnJ4NmNEyNhdXS5/z7iq4eA4fWCfyCR/SBv/W3OnVnx5ssr5NaKG5V2OjrC+uM4fygV7waLWSW+yjaL1cbepNeL2wnZTtjfNrolP+todsQ+kyRoZtHv2pDrW1ac8YvXt6THRFvRMDlbuPAUZpRiiGNKvKYY/nuDGAcbtDEUb0QS9o/AOrGOVWb49CbBeLupXlm8fgJi5PRXAIcsXOdnkpM5frExiDGlcRIgTFdkZohfs1IgSmiAD1z7/GoEQ3+i7c0E7gxiDJMKGHsqnzCsYfqn4cwiiqmpLu+jIyhgXCQGU/txGlWZmSgcemhDi6ZC0yLpASoCYwJ+jnhAijGKgUN+hnao0qHohnrbXrGcoZjEHxECSLgQp4SZyIssiKLKuonPAH+dYNZWFdfysRBWOQv1/jBUGROVlUOEERHjeHg/tPhEPBGFGY5QSowHB2M0VhLctbWgyp5nPNSTUj1cDnRB/WeKeeCm/iduEa3XHaGftQ8OB11zWEeN5ExCvdR5nuOpZxK68P6v9ZBKigsyrPYsxaS6k3X+SxdDHdbvJKWJkWot0nnO7jwPTX69ARDsJryRgX+WVpuY2y4MibpItm0vW0jYq2jnWfM188LBna09AtRm0WoV+bMc/SWZ71nnOAJ32xGnldOedQsQ1Mvmwro9Cym/ii7/z5wi2D6KQv1lFbFLNtRkaaZgZxFNnCFO2PfV+GofKq5+k6Mbfvpn2EJv/xWGUPOw1aDb9Jhh7ZL+Gg4H9r9w58sBh7H/9S48dr8i+J1MNYGVnGfktmSaRd+ekbX1tkhVfm22i07LujUKX7na6Rs7QA9/tfY1DnkCYVLoAKYBnjKovBGOCqGTzrlEn1m2aG7jjmNjWGyXNIqPaZg31WIEJhUQOVm8gTRZ6wrPh+y8NVbUNyASrwTldJHzzda3W9o5B+pApow+dUFNz/BtpFT/1xBwAA"; 
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
