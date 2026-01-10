const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, WAMessageContent, WAMessageStatus, downloadContentFromMessage, jidNormalizedUser, proto } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');

const ownerNumber = '254746404008@s.whatsapp.net'; // !! REPLACE WITH YOUR NUMBER (e.g., 254712345678@s.whatsapp.net)
const sessionID = process.env.SESSION_ID || 'auth_info'; // Reads from environment variable or defaults to 'auth_info' folder name

// Store previously seen messages to detect deletions
const messageStore = new Map();
// Store group links to detect antilink
const groupLinks = {}; 

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionID);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true, // Set to true to print QR in terminal
        browser: ['WhatsApp Bot', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error instanceof Boom?.multiDeviceAuthRequired;
            console.log('connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot connected!');
            // Set presence to 'always typing' once connected
            sock.sendPresenceUpdate('typing', ownerNumber); 
        }
    });

    // --- Anti-Delete Feature ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const messageKey = msg.key.id;

        // Store incoming message
        messageStore.set(messageKey, msg);
        
        // Handle message events
        handleMessages(sock, msg);
    });

    sock.ev.on('messages.delete', async (item) => {
        if (item.keys.length > 0) {
            for (const key of item.keys) {
                const deletedMsg = messageStore.get(key.id);
                if (deletedMsg && deletedMsg.key.remoteJid !== ownerNumber) {
                    const senderName = deletedMsg.pushName || deletedMsg.key.remoteJid;
                    const originalText = deletedMsg.message?.conversation || deletedMsg.message?.imageMessage?.caption || 'Media Message';
                    const warningMessage = `🚫 *Anti-Delete Alert* 🚫\n\nSender: ${senderName}\nMessage: ${originalText}`;
                    
                    // Send the deleted message content to the owner's DM
                    await sock.sendMessage(ownerNumber, { text: warningMessage });
                    
                    // If it was in a group, send a warning in the group chat (optional)
                    if (key.remoteJid.endsWith('@g.us')) {
                         await sock.sendMessage(key.remoteJid, { text: `${senderName} deleted a message! Anti-delete is active.` });
                    }

                    messageStore.delete(key.id);
                }
            }
        }
    });

    // --- Status Viewing ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
            if (contact.status) {
                console.log(`Status update from ${contact.notify}: ${contact.status}`);
            }
        }
    });

    sock.ev.on('presence.update', async (presence) => {
        // Can use this to monitor 'available' status, but status viewing is better handled via the stories mechanism.
    });
    
    // Auto status viewer
    sock.ev.on('stories.update', async (stories) => {
        for (const story of stories) {
            // Mark as seen immediately
            await sock.sendStoryView(story.jid); 
            console.log(`Viewed status from ${story.jid}`);

            // Download and send to owner's DM with emoji (simplified, real media handling is more complex)
            // This is a basic text notification, actual media download requires more logic.
            const statusMessage = `👀 Viewed status from ${story.jid} with text: "${story.storyMessage?.imageMessage?.caption || story.storyMessage?.videoMessage?.caption || 'Media Status'}"`;
            await sock.sendMessage(ownerNumber, { text: statusMessage });
        }
    });


    // --- Core Message Handler (Antilink, VV Save, Commands) ---
    async function handleMessages(sock, msg) {
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const command = messageContent.toLowerCase().split(' ')[0];
        const isOwner = jid === ownerNumber || msg.key.participant === ownerNumber; // Checks if sender is the owner

        // Always Typing (handled in connection update, but can be set here on message too)
        await sock.sendPresenceUpdate('typing', jid);

        // --- Anti-Link Feature ---
        if (isGroup && messageContent.includes('http')) {
            const groupMetadata = await sock.groupMetadata(jid);
            // Check for invite links in message
            const inviteRegex = /(https?:\/\/chat\.whatsapp\.com\/(?:invite\/)?[a-zA-Z0-9_-]+)/gi;
            if (inviteRegex.test(messageContent)) {
                // Kick the sender if they post a link (requires bot to be admin)
                const senderJid = msg.key.participant;
                // Note: Kicking requires the bot to have admin privileges.
                // await sock.groupParticipantsUpdate(jid, [senderJid], 'remove'); 
                await sock.sendMessage(jid, { text: "Link detected! Link has been deleted." });
                // Delete the message containing the link
                await sock.sendMessage(jid, { delete: msg.key });
                console.log(`Kicked user ${senderJid} for posting a link in ${groupMetadata.subject}`);
                return; // Stop further processing
            }
        }

        // --- VV (View Once) Message Saving ---
        if (msg.message?.viewOnceMessageV2?.message) {
            const viewOnce = msg.message.viewOnceMessageV2.message;
            const type = Object.keys(viewOnce)[0]; 
            const mediaKey = viewOnce[type].mediaKey;
            const mimetype = viewOnce[type].mimetype;
            const stream = await downloadContentFromMessage(viewOnce[type], type.includes('image') ? 'image' : 'video');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat(buffer, chunk);
            }
            
            // Send the saved media to the owner's DM
            const caption = `*View Once Saved!* from ${msg.pushName || jid}`;
            if (type.includes('image')) {
                await sock.sendMessage(ownerNumber, { image: buffer, caption: caption });
            } else if (type.includes('video')) {
                await sock.sendMessage(ownerNumber, { video: buffer, caption: caption });
            }
            // Acknowledge receipt to the sender (optional)
            await sock.sendMessage(jid, { text: "View Once message has been saved to the inbox." });
        }


        // --- Bot Commands (Block, Kick) ---
        if (messageContent.startsWith('#') && isOwner) {
            const args = messageContent.split(' ');
            if (command === '#block') {
                const numberToBlock = args[1]; // expects number in format '2547xxxxxxx'
                if (numberToBlock) {
                    const blockJid = numberToBlock + '@s.whatsapp.net';
                    await sock.updateBlockStatus(blockJid, 'block');
                    await sock.sendMessage(jid, { text: `Blocked ${numberToBlock}` });
                }
            } else if (command === '#kick' && isGroup) {
                const numberToKick = args[1]; // expects number in format '2547xxxxxxx'
                const participantJid = numberToKick + '@s.whatsapp.net';
                // Note: The bot *must* be a group admin for this to work.
                await sock.groupParticipantsUpdate(jid, [participantJid], 'remove');
                await sock.sendMessage(jid, { text: `Kicked ${numberToKick} from the group.` });
            }
        }
    }
}

startBot();
