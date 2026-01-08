const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const zlib = require('zlib');
const { Boom } = require("@hapi/boom");

const SESSION_ID = "KEITH;;;H4sIAAAAAAAAA5VU2Y6jOBT9F78manZCkEoatgSyEFLZIKN5MGAIFbayDYRq5d9HpLq6WiNNTw1PxrbuPfcs/g7KKiNoiXqgfgc1zlpI0bCkfY2ACvQmSRAGYxBDCoEKqvmVwsWJJ1xesi9apRTLw9H2WjNpeGZGT3P51nKBZtp++gTuY1A3YZ5FvynodKwRrYLzqOsKJ+C5EHP8cractr61CF07bEcjRjuK1Xm3fgL3oSLMcFamVn1BBcIwX6Legxn+GvzCDTDD6PMgVyYSw7qTfhcysuTMWyhMpvVz0h0tAW9oIURfg/864wNvFnN8WrvmprSf3ybPXZg3Gw5KFnVeREOb0DCrKae9wydZWqLYiVFJM9p/mfeD1ZxHoSFtyJy/NPS5FrfTw2XeQHoxkgw2zHNlek2W0FP1NeBv0vHl4Gz2u8tkNytTHJ63WNNl91Wmq2T25kXOaoVSa7rlul+Be/jDK9f/w/vVs8XDbhEG5mlGGYqrgyR7xhUaR46tUmk094Ua+/aIKYKvwccHX3itvLWzer75bgtfnJ4NmNEyNhdXS5/z7iq4eA4fWCfyCR/SBv/W3OnVnx5ssr5NaKG5V2OjrC+uM4fygV7waLWSW+yjaL1cbepNeL2wnZTtjfNrolP+todsQ+kyRoZtHv2pDrW1ac8YvXt6THRFvRMDlbuPAUZpRiiGNKvKYY/nuDGAcbtDEUb0QS9o/AOrGOVWb49CbBeLupXlm8fgJi5PRXAIcsXOdnkpM5frExiDGlcRIgTFdkZohfs1IgSmiAD1z7/GoEQ3+i7c0E7gxiDJMKGHsqnzCsYfqn4cwiiqmpLu+jIyhgXCQGU/txGlWZmSgcemhDi6ZC0yLpASoCYwJ+jnhAijGKgUN+hnao0qHohnrbXrGcoZjEHxECSLgQp4SZyIssiKLKuonPAH+dYNZWFdfysRBWOQv1/jBUGROVlUOEERHjeHg/tPhEPBGFGY5QSowHB2M0VhLctbWgyp5nPNSTUj1cDnRB/WeKeeCm/iduEa3XHaGftQ8OB11zWEeN5ExCvdR5nuOpZxK68P6v9ZBKigsyrPYsxaS6k3X+SxdDHdbvJKWJkWot0nnO7jwPTX69ARDsJryRgX+WVpuY2y4MibpItm0vW0jYq2jnWfM188LBna09AtRm0WoV+bMc/SWZ71nnOAJ32xGnldOedQsQ1Mvmwro9Cym/ii7/z5wi2D6KQv1lFbFLNtRkaaZgZxFNnCFO2PfV+GofKq5+k6Mbfvpn2EJv/xWGUPOw1aDb9Jhh7ZL+Gg4H9r9w58sBh7H/9S48dr8i+J1MNYGVnGfktmSaRd+ekbX1tkhVfm22i07LujUKX7na6Rs7QA9/tfY1DnkCYVLoAKYBnjKovBGOCqGTzrlEn1m2aG7jjmNjWGyXNIqPaZg31WIEJhUQOVm8gTRZ6wrPh+y8NVbUNyASrwTldJHzzda3W9o5B+pApow+dUFNz/BtpFT/1xBwAA";
const PREFIX = "!";

async function startBot() {
    if (!fs.existsSync('./session')) fs.mkdirSync('./session');
    try {
        const buffer = Buffer.from(SESSION_ID.split(';;;')[1], 'base64');
        const jsonString = zlib.gunzipSync(buffer).toString();
        fs.writeFileSync('./session/creds.json', jsonString);
    } catch (e) { console.log("❌ SESSION ERROR"); return; }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    
    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Knight-Lite", "Chrome", "3.0.0"],
        printQRInTerminal: false,
        shouldSyncHistoryMessage: () => false, 
        syncFullHistory: false
    });

    conn.ev.on('creds.update', saveCreds);

    // --- THE FIX: ROBUST MESSAGE LISTENER ---
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;

            // 1. EXTRACT TEXT (Ultra-Robust Version)
            let type = getContentType(m.message);
            let body = (type === 'conversation') ? m.message.conversation : 
                       (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                       (type === 'imageMessage' || type === 'videoMessage') ? m.message[type].caption : 
                       (type === 'viewOnceMessageV2') ? m.message.viewOnceMessageV2.message[getContentType(m.message.viewOnceMessageV2.message)].caption : "";

            // --- EMERGENCY DEBUG ---
            // This will print every message you send to the bot in the terminal.
            console.log(`[RECEIVED] From: ${from} | Message: ${body}`);

            // 2. COMMAND HANDLING
            if (body.startsWith(PREFIX)) {
                const args = body.slice(PREFIX.length).trim().split(/\s+/);
                const command = args.shift().toLowerCase();

                console.log(`[EXECUTING] Command: ${command}`);

                if (command === "ping") {
                    return await conn.sendMessage(from, { text: "☠️ *Knight-Lite Ultra* is responding!" }, { quoted: m });
                }

                if (command === "alive") {
                    return await conn.sendMessage(from, { text: "I am online and reading your commands. ✅" }, { quoted: m });
                }
            }

            // 3. AUTO-REACTION (To prove the bot sees you)
            if (body === "test") {
                await conn.sendMessage(from, { text: "Test successful! I can see your messages." }, { quoted: m });
            }

        } catch (err) {
            console.log("Error in listener: ", err);
        }
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT ONLINE');
            const myJid = conn.user.id.split(':')[0] + "@s.whatsapp.net";
            await conn.sendMessage(myJid, { text: "⚔️ *Knight-Lite Ultra Connected*\n\nSend `!ping` to test me." });
        }
    });
}

startBot();
