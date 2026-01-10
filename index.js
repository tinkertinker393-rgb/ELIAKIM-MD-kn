const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay, 
    jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');

const ownerNumber = '254746404008@s.whatsapp.net'; // !! REPLACE WITH YOUR NUMBER
const sessionID = process.env.SESSION_ID || 'auth_info';

const messageStore = new Map();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionID);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Digital Bot', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot connected!');
            
            // --- Digital Connection Message ---
            const digitalMsg = `
╔════════════════════════╗
║    ✨ SYSTEM ONLINE ✨    ║
╠════════════════════════╣
║ 🟢 Status: Connected   ║
║ 🤖 Bot: Baileys-MD    ║
║ 🛡️ Anti-Delete: Active ║
║ 🔗 Anti-Link: Active   ║
╚════════════════════════╝`;
            
            await sock.sendMessage(ownerNumber, { text: digitalMsg });
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const jid = msg.key.remoteJid;

        // --- Always Typing Logic ---
        // Tells the specific chat the bot is typing as soon as a message arrives
        await sock.sendPresenceUpdate('composing', jid);

        // --- Auto Status Like (Reaction) ---
        if (jid === 'status@broadcast') {
            const emojis = ['❤️', '🔥', '✨', '🙌', '💯', '⚡', '🤖'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            
            await sock.sendMessage('status@broadcast', {
                react: { key: msg.key, text: randomEmoji }
            }, { statusJidList: [msg.key.participant] });
            
            console.log(`✅ Reacted to status from: ${msg.pushName || 'User'}`);
            return;
        }

        const messageKey = msg.key.id;
        messageStore.set(messageKey, msg);
        handleMessages(sock, msg);
    });

    // --- Anti-Delete Feature ---
    sock.ev.on('messages.delete', async (item) => {
        if (item.keys.length > 0) {
            for (const key of item.keys) {
                const deletedMsg = messageStore.get(key.id);
                if (deletedMsg && deletedMsg.key.remoteJid !== ownerNumber) {
                    const senderName = deletedMsg.pushName || deletedMsg.key.remoteJid;
                    const originalText = deletedMsg.message?.conversation || deletedMsg.message?.extendedTextMessage?.text || deletedMsg.message?.imageMessage?.caption || 'Media Message';
                    const warningMessage = `🚫 *Anti-Delete Alert* 🚫\n\nSender: ${senderName}\nMessage: ${originalText}`;

                    await sock.sendMessage(ownerNumber, { text: warningMessage });
                    messageStore.delete(key.id);
                }
            }
        }
    });

    // --- Core Message Handler ---
    async function handleMessages(sock, msg) {
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const command = messageContent.toLowerCase().split(' ')[0];

        // Antilink logic
        if (isGroup && messageContent.includes('chat.whatsapp.com')) {
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const participants = groupMetadata.participants;
                const senderIsAdmin = participants.find(p => p.id === senderJid)?.admin !== null;

                if (!senderIsAdmin) {
                    await sock.sendMessage(jid, { text: '🚫 *Links are not allowed here!*' });
                    await sock.groupParticipantsUpdate(jid, [senderJid], 'remove');
                }
            } catch (e) {
                console.log("Antilink Error: Bot might not be admin.");
            }
        }

        // Basic commands
        if (command === '!ping') {
            await sock.sendMessage(jid, { text: 'Pong! ⚡' });
        }

        if (command === '!menu') {
            const menuText = `*🤖 DIGITAL BOT MENU*\n\nAvailable commands:\n- !ping: Check latency\n- !menu: Show this list\n\n_Features active: Anti-Delete, Anti-Link, Auto-Status Like_`;
            await sock.sendMessage(jid, { text: menuText });
        }
    }
}

startBot();
