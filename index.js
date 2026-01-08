const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType 
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const zlib = require('zlib');
const { Boom } = require("@hapi/boom");

// --- CONFIGURATION ---
const SESSION_ID = "KEITH;;;H4sIAAAAAAAAA5VU2Y6jOBT9F78manZCkEoatgSyEFLZIKN5MGAIFbayDYRq5d9HpLq6WiNNTw1PxrbuPfcs/g7KKiNoiXqgfgc1zlpI0bCkfY2ACvQmSRAGYxBDCoEKqvmVwsWJJ1xesi9apRTLw9H2WjNpeGZGT3P51nKBZtp++gTuY1A3YZ5FvynodKwRrYLzqOsKJ+C5EHP8cractr61CF07bEcjRjuK1Xm3fgL3oSLMcFamVn1BBcIwX6Legxn+GvzCDTDD6PMgVyYSw7qTfhcysuTMWyhMpvVz0h0tAW9oIURfg/864wNvFnN8WrvmprSf3ybPXZg3Gw5KFnVeREOb0DCrKae9wydZWqLYiVFJM9p/mfeD1ZxHoSFtyJy/NPS5FrfTw2XeQHoxkgw2zHNlek2W0FP1NeBv0vHl4Gz2u8tkNytTHJ63WNNl91Wmq2T25kXOaoVSa7rlul+Be/jDK9f/w/vVs8XDbhEG5mlGGYqrgyR7xhUaR46tUmk094Ua+/aIKYKvwccHX3itvLWzer75bgtfnJ4NmNEyNhdXS5/z7iq4eA4fWCfyCR/SBv/W3OnVnx5ssr5NaKG5V2OjrC+uM4fygV7waLWSW+yjaL1cbepNeL2wnZTtjfNrolP+todsQ+kyRoZtHv2pDrW1ac8YvXt6THRFvRMDlbuPAUZpRiiGNKvKYY/nuDGAcbtDEUb0QS9o/AOrGOVWb49CbBeLupXlm8fgJi5PRXAIcsXOdnkpM5frExiDGlcRIgTFdkZohfs1IgSmiAD1z7/GoEQ3+i7c0E7gxiDJMKGHsqnzCsYfqn4cwiiqmpLu+jIyhgXCQGU/txGlWZmSgcemhDi6ZC0yLpASoCYwJ+jnhAijGKgUN+hnao0qHohnrbXrGcoZjEHxECSLgQp4SZyIssiKLKuonPAH+dYNZWFdfysRBWOQv1/jBUGROVlUOEERHjeHg/tPhEPBGFGY5QSowHB2M0VhLctbWgyp5nPNSTUj1cDnRB/WeKeeCm/iduEa3XHaGftQ8OB11zWEeN5ExCvdR5nuOpZxK68P6v9ZBKigsyrPYsxaS6k3X+SxdDHdbvJKWJkWot0nnO7jwPTX69ARDsJryRgX+WVpuY2y4MibpItm0vW0jYq2jnWfM188LBna09AtRm0WoV+bMc/SWZ71nnOAJ32xGnldOedQsQ1Mvmwro9Cym/ii7/z5wi2D6KQv1lFbFLNtRkaaZgZxFNnCFO2PfV+GofKq5+k6Mbfvpn2EJv/xWGUPOw1aDb9Jhh7ZL+Gg4H9r9w58sBh7H/9S48dr8i+J1MNYGVnGfktmSaRd+ekbX1tkhVfm22i07LujUKX7na6Rs7QA9/tfY1DnkCYVLoAKYBnjKovBGOCqGTzrlEn1m2aG7jjmNjWGyXNIqPaZg31WIEJhUQOVm8gTRZ6wrPh+y8NVbUNyASrwTldJHzzda3W9o5B+pApow+dUFNz/BtpFT/1xBwAA"; 
const messageStorage = {}; 

// This function automatically creates the session folder and creds.json
async function authSession() {
    if (!fs.existsSync('./session')) {
        fs.mkdirSync('./session');
    }
    if (!fs.existsSync('./session/creds.json')) {
        try {
            console.log("Restoring session from ID...");
            const base64Data = SESSION_ID.split(';;;')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            const jsonString = zlib.gunzipSync(buffer).toString();
            fs.writeFileSync('./session/creds.json', jsonString);
            console.log("✅ session/creds.json created successfully.");
        } catch (e) {
            console.log("❌ Failed to restore session. Check your Session ID.");
        }
    }
}

async function startBot() {
    await authSession();
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ["Knight-Lite", "Chrome", "3.0"]
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message || m.key.fromMe) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const sender = m.key.participant || m.key.remoteJid;

            let body = (type === 'conversation') ? m.message.conversation : 
                       (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                       (type === 'imageMessage' || type === 'videoMessage') ? m.message[type].caption : "";

            messageStorage[m.key.id] = m;

            // ANTI-LINK
            if (from.endsWith('@g.us') && /(https?:\/\/[^\s]+)/g.test(body)) {
                await conn.sendMessage(from, { delete: m.key });
                await conn.sendMessage(from, { text: "🛡️ *Anti-Link Activated*" });
            }

            // PING
            if (body.toLowerCase() === "ping") {
                await conn.sendMessage(from, { text: "☠️ *Knight-Lite is Live!*" }, { quoted: m });
            }
        } catch (err) { console.log(err); }
    });

    conn.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage?.type === 0) { 
                const deletedMsg = messageStorage[update.key.id];
                if (deletedMsg) {
                    await conn.sendMessage(update.key.remoteJid, { 
                        text: `🛡️ *Anti-Delete Detected*`
                    });
                }
            }
        }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT IS ONLINE');
        }
    });
}

startBot();
