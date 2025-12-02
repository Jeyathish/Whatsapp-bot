const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const EventEmitter = require('events');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

class WhatsAppBot extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.isConnected = false;
        this.authFolder = './auth_info_baileys';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.isLoggingOut = false;
        this.keepAliveInterval = null;
        this.connectionTimeout = null;
    }

    async start() {
        try {
            this.reconnectAttempts++;
            this.clearIntervals();

            // Clear corrupted auth
            if (fs.existsSync(this.authFolder)) {
                try {
                    const files = fs.readdirSync(this.authFolder);
                    const hasCorrupted = files.some(f => {
                        try {
                            const filePath = path.join(this.authFolder, f);
                            if (fs.statSync(filePath).size === 0) return true;
                            if (f.endsWith('.json')) {
                                const content = fs.readFileSync(filePath, 'utf8');
                                JSON.parse(content);
                            }
                            return false;
                        } catch {
                            return true;
                        }
                    });

                    if (hasCorrupted) {
                        console.log('🧹 Clearing corrupted auth files...');
                        fs.rmSync(this.authFolder, { recursive: true, force: true });
                    }
                } catch (err) {
                    fs.rmSync(this.authFolder, { recursive: true, force: true });
                }
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            console.log(`📦 Using baileys version: ${version.join('.')}${isLatest ? ' (latest)' : ''}`);

            // Create custom logger to avoid the child function error
            const logger = {
                trace: () => { },
                debug: () => { },
                info: () => { },
                warn: (msg, ...args) => console.log('⚠️', msg, ...args),
                error: (msg, ...args) => console.error('❌', msg, ...args),
                fatal: (msg, ...args) => console.error('💀', msg, ...args),
                child: () => logger // Return itself to avoid errors
            };

            this.sock = makeWASocket({
                version,
                auth: state,
                logger: logger,
                browser: Browsers.ubuntu('Chrome'),
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 20000,
                markOnlineOnConnect: true,
                syncFullHistory: false,
                mobile: false,
                retryRequestDelayMs: 1000,
                maxRetries: 3,
                defaultQueryTimeoutMs: 60000,
                emitOwnEvents: true,
                fireInitQueries: true,
                shouldIgnoreJid: () => false,
                generateHighQualityLinkPreview: false,
                getMessage: async () => ({ conversation: '' }),
                linkPreviewImageThumbnailWidth: 192,
                treatCiphertextMessagesAsReal: false,
                downloadHistory: false,
                transactionOpts: {
                    maxCommitRetries: 10,
                    delayBetweenTriesMs: 3000
                }
            });

            // Save credentials
            this.sock.ev.on('creds.update', saveCreds);

            // Handle connection updates
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;

                console.log('🔌 Connection update:', {
                    connection,
                    qr: !!qr,
                    isNewLogin,
                    error: lastDisconnect?.error?.message || lastDisconnect?.error?.output?.statusCode || 'none'
                });

                if (qr) {
                    console.log('\n📱 QR Code Received!');
                    qrcode.generate(qr, { small: true });
                    console.log('\n=== IMPORTANT INSTRUCTIONS ===');
                    console.log('1. Open WhatsApp → Settings → Linked Devices');
                    console.log('2. Tap "Link a Device"');
                    console.log('3. Tap "Link with phone number"');
                    console.log('4. Scan QR within 30 seconds');
                    console.log('5. Wait for "Ready" message');
                    console.log('==============================\n');
                    this.emit('qr', qr);
                    this.reconnectAttempts = 0;
                }

                if (connection === 'open') {
                    console.log('✅ WhatsApp bot connected successfully!');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.emit('ready');

                    // Start keep-alive mechanism
                    this.startKeepAlive();

                    // Set initial presence
                    try {
                        await this.sock.sendPresenceUpdate('available');
                        console.log('👁️ Presence updated to "available"');
                    } catch (err) {
                        console.log('⚠️ Could not set presence:', err.message);
                    }

                    // Send periodic presence updates
                    setInterval(async () => {
                        if (this.isConnected && this.sock) {
                            try {
                                await this.sock.sendPresenceUpdate('available');
                            } catch (err) {
                                // Silent fail
                            }
                        }
                    }, 30000);
                }

                if (connection === 'close') {
                    this.isConnected = false;
                    this.clearIntervals();

                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    const shouldReconnect = !this.isLoggingOut;

                    console.log('❌ Connection closed. Status:', statusCode || 'unknown');

                    if (error?.message) {
                        console.log('Error details:', error.message);
                    }

                    if (!shouldReconnect) {
                        console.log('🚪 Logout requested, not reconnecting');
                        return;
                    }

                    // Handle specific disconnect reasons
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log('🚪 Logged out by server, clearing auth...');
                        this.handleLogout();
                        setTimeout(() => {
                            this.reconnectAttempts = 0;
                            this.start();
                        }, 5000);
                    }
                    else if (statusCode === DisconnectReason.restartRequired ||
                        statusCode === 515) {
                        console.log('🔄 Server restart required...');
                        setTimeout(() => this.start(), 2000);
                    }
                    else if (statusCode === DisconnectReason.connectionLost ||
                        statusCode === DisconnectReason.timedOut) {
                        console.log('🔌 Connection lost, reconnecting...');
                        setTimeout(() => this.start(), 3000);
                    }
                    else if (statusCode === 401) {
                        console.log('🔐 Authentication failed, clearing auth...');
                        this.handleLogout();
                        setTimeout(() => {
                            this.reconnectAttempts = 0;
                            this.start();
                        }, 5000);
                    }
                    else if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        const delay = Math.min(3000 * this.reconnectAttempts, 20000);
                        console.log(`🔄 Reconnecting in ${delay / 1000}s (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
                        setTimeout(() => this.start(), delay);
                    } else {
                        console.log('❌ Max reconnection attempts reached');
                        this.handleLogout();
                        this.reconnectAttempts = 0;
                        setTimeout(() => this.start(), 10000);
                    }
                }

                if (connection === 'connecting') {
                    console.log('🔄 Connecting to WhatsApp...');
                    this.emit('connecting');
                }
            });

            // Handle messages
            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                try {
                    const msg = messages[0];
                    if (!msg.message || msg.key.fromMe) return;

                    const sender = msg.key.remoteJid;
                    const text = msg.message.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        '';

                    if (text) {
                        console.log(`📥 Message from ${sender}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
                    }
                } catch (err) {
                    console.error('Error handling message:', err.message);
                }
            });

            // Handle connection errors
            this.sock.ev.on('connection-error', (err) => {
                console.error('🔌 Connection error:', err.message);
            });

        } catch (error) {
            console.error('❌ Failed to start bot:', error.message);
            console.error('Stack:', error.stack);

            const delayTime = Math.min(5000 * this.reconnectAttempts, 30000);
            console.log(`🔄 Retrying in ${delayTime / 1000} seconds...`);
            setTimeout(() => this.start(), delayTime);
        }
    }

    startKeepAlive() {
        this.clearIntervals();

        this.keepAliveInterval = setInterval(async () => {
            if (this.sock && this.isConnected) {
                try {
                    // Send a presence update to keep connection alive
                    await this.sock.sendPresenceUpdate('available');
                } catch (error) {
                    console.log('⚠️ Keep-alive failed:', error.message);
                    // Don't restart here, let connection.update handle it
                }
            }
        }, 25000);
    }

    clearIntervals() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    async sendMessage(number, message) {
        if (!this.sock || !this.isConnected) {
            throw new Error('Bot not connected. Please wait for connection.');
        }

        try {
            const cleanNumber = number.replace(/\D/g, '');
            if (!cleanNumber || cleanNumber.length < 10) {
                throw new Error('Invalid phone number');
            }

            const jid = cleanNumber.includes('@s.whatsapp.net') ?
                cleanNumber :
                `${cleanNumber}@s.whatsapp.net`;

            console.log(`📤 Sending message to ${cleanNumber}...`);

            const sentMsg = await this.sock.sendMessage(jid, {
                text: message
            });

            console.log(`✅ Message sent to ${cleanNumber}`);
            return { success: true, id: sentMsg.key.id, number: cleanNumber };

        } catch (error) {
            console.error('❌ Failed to send message:', error.message);

            if (error.message.includes('not connected') ||
                error.message.includes('Socket closed') ||
                error.message.includes('timed out')) {
                console.log('🔄 Connection issue detected, restarting...');
                this.restart();
            }

            throw error;
        }
    }

    handleLogout() {
        this.clearIntervals();
        this.isConnected = false;

        if (fs.existsSync(this.authFolder)) {
            try {
                fs.rmSync(this.authFolder, { recursive: true, force: true });
                console.log('🧹 Auth files cleared');
            } catch (err) {
                console.log('⚠️ Error clearing auth:', err.message);
            }
        }

        this.emit('logout');
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            hasAuth: fs.existsSync(this.authFolder) &&
                fs.readdirSync(this.authFolder).length > 0,
            reconnectAttempts: this.reconnectAttempts
        };
    }

    async restart() {
        console.log('🔄 Restarting WhatsApp connection...');
        this.clearIntervals();
        this.isConnected = false;

        if (this.sock) {
            try {
                await this.sock.end();
            } catch (err) {
                // Ignore errors during cleanup
            }
            this.sock = null;
        }

        setTimeout(() => {
            this.reconnectAttempts = 0;
            this.start();
        }, 2000);
    }

    async logout() {
        console.log('🚪 Logging out...');
        this.isLoggingOut = true;
        this.clearIntervals();

        if (this.sock) {
            try {
                await this.sock.logout();
            } catch (err) {
                console.log('⚠️ Error during logout:', err.message);
            }
        }

        this.handleLogout();
        this.isLoggingOut = false;
        console.log('✅ Logged out successfully');
    }

    cleanup() {
        this.clearIntervals();
        if (this.sock) {
            try {
                this.sock.end();
            } catch (err) {
                // Ignore
            }
        }
    }
}

// Handle process exit
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    if (global.botInstance) {
        global.botInstance.cleanup();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Received termination signal...');
    if (global.botInstance) {
        global.botInstance.cleanup();
    }
    process.exit(0);
});

module.exports = WhatsAppBot;