const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    jidDecode
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require('fs');
const zlib = require('zlib');
const { Boom } = require("@hapi/boom");

// --- CONFIG ---
const SESSION_ID = "KEITH;;;H4sIAAAAAAAAA5VU2Y6jOBT9F78manZCkEoatgSyEFLZIKN5MGAIFbayDYRq5d9HpLq6WiNNTw1PxrbuPfcs/g7KKiNoiXqgfgc1zlpI0bCkfY2ACvQmSRAGYxBDCoEKqvmVwsWJJ1xesi9apRTLw9H2WjNpeGZGT3P51nKBZtp++gTuY1A3YZ5FvynodKwRrYLzqOsKJ+C5EHP8cractr61CF07bEcjRjuK1Xm3fgL3oSLMcFamVn1BBcIwX6Legxn+GvzCDTDD6PMgVyYSw7qTfhcysuTMWyhMpvVz0h0tAW9oIURfg/864wNvFnN8WrvmprSf3ybPXZg3Gw5KFnVeREOb0DCrKae9wydZWqLYiVFJM9p/mfeD1ZxHoSFtyJy/NPS5FrfTw2XeQHoxkgw2zHNlek2W0FP1NeBv0vHl4Gz2u8tkNytTHJ63WNNl91Wmq2T25kXOaoVSa7rlul+Be/jDK9f/w/vVs8XDbhEG5mlGGYqrgyR7xhUaR46tUmk094Ua+/aIKYKvwccHX3itvLWzer75bgtfnJ4NmNEyNhdXS5/z7iq4eA4fWCfyCR/SBv/W3OnVnx5ssr5NaKG5V2OjrC+uM4fygV7waLWSW+yjaL1cbepNeL2wnZTtjfNrolP+todsQ+kyRoZtHv2pDrW1ac8YvXt6THRFvRMDlbuPAUZpRiiGNKvKYY/nuDGAcbtDEUb0QS9o/AOrGOVWb49CbBeLupXlm8fgJi5PRXAIcsXOdnkpM5frExiDGlcRIgTFdkZohfs1IgSmiAD1z7/GoEQ3+i7c0E7gxiDJMKGHsqnzCsYfqn4cwiiqmpLu+jIyhgXCQGU/txGlWZmSgcemhDi6ZC0yLpASoCYwJ+jnhAijGKgUN+hnao0qHohnrbXrGcoZjEHxECSLgQp4SZyIssiKLKuonPAH+dYNZWFdfysRBWOQv1/jBUGROVlUOEERHjeHg/tPhEPBGFGY5QSowHB2M0VhLctbWgyp5nPNSTUj1cDnRB/WeKeeCm/iduEa3XHaGftQ8OB11zWEeN5ExCvdR5nuOpZxK68P6v9ZBKigsyrPYsxaS6k3X+SxdDHdbvJKWJkWot0nnO7jwPTX69ARDsJryRgX+WVpuY2y4MibpItm0vW0jYq2jnWfM188LBna09AtRm0WoV+bMc/SWZ71nnOAJ32xGnldOedQsQ1Mvmwro9Cym/ii7/z5wi2D6KQv1lFbFLNtRkaaZgZxFNnCFO2PfV+GofKq5+k6Mbfvpn2EJv/xWGUPOw1aDb9Jhh7ZL+Gg4H9r9w58sBh7H/9S48dr8i+J1MNYGVnGfktmSaRd+ekbX1tkhVfm22i07LujUKX7na6Rs7QA9/tfY1DnkCYVLoAKYBnjKovBGOCqGTzrlEn1m2aG7jjmNjWGyXNIqPaZg31WIEJhUQOVm8gTRZ6wrPh+y8NVbUNyASrwTldJHzzda3W9o5B+pApow+dUFNz/BtpFT/1xBwAA"; 
const PREFIX = "!"; 
const startTime = Date.now();

// --- UTILS ---
const runtime = (seconds) => {
    seconds = Number(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor(seconds % (3600 * 24) / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);
    return `${d > 0 ? d + 'd ' : ''}${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${s}s`;
}

async function startBot() {
    if (!fs.existsSync('./session')) fs.mkdirSync('./session');
    try {
        const base64Data = SESSION_ID.split(';;;')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        const jsonString = zlib.gunzipSync(buffer).toString();
        fs.writeFileSync('./session/creds.json', jsonString);
    } catch (e) { console.log("❌ Session Error"); return; }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Knight-Lite", "Chrome", "3.0.0"],
        shouldSyncHistoryMessage: () => false,
    });

    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            if (chatUpdate.type !== 'notify') return;
            const m = chatUpdate.messages[0];
            if (!m.message) return;

            const from = m.key.remoteJid;
            const type = getContentType(m.message);
            const pushname = m.pushName || "User";
            
            // --- MESSAGE CAPTURE (THE FIX) ---
            let body = (type === 'conversation') ? m.message.conversation : 
                       (type === 'extendedTextMessage') ? m.message.extendedTextMessage.text : 
                       (m.message[type]?.caption) ? m.message[type].caption : "";

            if (!body.startsWith(PREFIX)) return;

            const args = body.slice(PREFIX.length).trim().split(/\s+/);
            const command = args.shift().toLowerCase();

            console.log(`💡 [CMD] ${command} from ${pushname}`);

            switch (command) {
                // 1. SYSTEM COMMANDS
                case 'menu':
                case 'help':
                    const menu = `
☠️ *KNIGHT-LITE ULTRA* ☠️
_The fastest session-based bot._

*🚀 SYSTEM*
• ${PREFIX}ping - Speed test
• ${PREFIX}alive - Bot status
• ${PREFIX}runtime - Uptime

*👥 GROUP*
• ${PREFIX}tagall - Mention all
• ${PREFIX}hidetag - Ghost mention
• ${PREFIX}group - Get group link

*📸 MEDIA*
• ${PREFIX}sticker - Create sticker
• ${PREFIX}vv - Recover view once
`;
                    await conn.sendMessage(from, { text: menu }, { quoted: m });
                    break;

                case 'ping':
                    const start = Date.now();
                    const { key } = await conn.sendMessage(from, { text: "🚀 *Testing Speed...*" }, { quoted: m });
                    const end = Date.now();
                    await conn.sendMessage(from, { text: `☠️ *Response:* ${end - start}ms`, edit: key });
                    break;

                case 'alive':
                    await conn.sendMessage(from, { 
                        text: `*Knight-Lite Ultra is Active!*\n*User:* ${pushname}\n*Runtime:* ${runtime((Date.now() - startTime) / 1000)}`,
                        contextInfo: { externalAdReply: { title: "KNIGHT-LITE ACTIVE", body: "System Stable", showAdAttribution: true }}
                    }, { quoted: m });
                    break;

                case 'runtime':
                    await conn.sendMessage(from, { text: `⏳ *Uptime:* ${runtime((Date.now() - startTime) / 1000)}` }, { quoted: m });
                    break;

                // 2. GROUP COMMANDS
                case 'tagall':
                    if (!from.endsWith('@g.us')) return;
                    const groupMetadata = await conn.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    let text = `📢 *TAG ALL*\n\n*Message:* ${args.join(" ") || "No context"}\n\n`;
                    for (let mem of participants) {
                        text += ` @${mem.id.split('@')[0]}`;
                    }
                    await conn.sendMessage(from, { text: text, mentions: participants.map(a => a.id) }, { quoted: m });
                    break;

                case 'hidetag':
                    if (!from.endsWith('@g.us')) return;
                    const metadata = await conn.groupMetadata(from);
                    await conn.sendMessage(from, { text: args.join(" ") || "", mentions: metadata.participants.map(a => a.id) });
                    break;

                // 3. MEDIA COMMANDS
                case 'sticker':
                case 's':
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage || m.message;
                    const mime = Object.keys(quoted)[0];
                    if (mime === 'imageMessage' || mime === 'videoMessage') {
                        const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await conn.sendMessage(from, { sticker: buffer }, { quoted: m });
                    } else {
                        await conn.sendMessage(from, { text: "Reply to an image/video to make sticker." });
                    }
                    break;

                case 'vv':
                    const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!q) return;
                    const viewOnce = q.viewOnceMessageV2 || q.viewOnceMessage;
                    if (!viewOnce) return;
                    const mediaType = Object.keys(viewOnce.message)[0];
                    const buffer = await downloadMediaMessage({ message: viewOnce.message }, 'buffer', {});
                    const payload = { caption: "🔓 *View Once Recovered*" };
                    if (mediaType === 'imageMessage') payload.image = buffer;
                    else if (mediaType === 'videoMessage') payload.video = buffer;
                    await conn.sendMessage(conn.user.id.split(':')[0] + "@s.whatsapp.net", payload);
                    break;
            }

        } catch (err) { console.error(err); }
    });

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            console.log('✅ BOT ONLINE WITH SESSION ID');
        }
    });
}

startBot();
