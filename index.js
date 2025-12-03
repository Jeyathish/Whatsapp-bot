import {
    makeWASocket,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} from '@whiskeysockets/baileys';
import EventEmitter from "events";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";

export default class WhatsAppBot extends EventEmitter {
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

            // Custom logger
            const logger = {
                trace: () => { },
                debug: () => { },
                info: () => { },
                warn: (msg, ...args) => console.log('⚠️', msg, ...args),
                error: (msg, ...args) => console.error('❌', msg, ...args),
                fatal: (msg, ...args) => console.error('💀', msg, ...args),
                child: () => logger
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

            this.sock.ev.on('creds.update', saveCreds);

            // Connection updates
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;

                console.log('🔌 Connection update:', {
                    connection,
                    qr: !!qr,
                    isNewLogin,
                    error: lastDisconnect?.error?.message || lastDisconnect?.error?.output?.statusCode || 'none'
                });

                if (qr) {
                    qrcode.generate(qr, { small: true });
                    this.emit('qr', qr);
                    this.reconnectAttempts = 0;
                }

                if (connection === 'open') {
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.emit('ready');
                    this.startKeepAlive();
                }

                if (connection === 'close') {
                    this.isConnected = false;
                    this.clearIntervals();
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = !this.isLoggingOut;

                    if (!shouldReconnect) return;

                    if (statusCode === DisconnectReason.loggedOut) {
                        this.handleLogout();
                        setTimeout(() => this.start(), 5000);
                    } else if (statusCode === DisconnectReason.restartRequired) {
                        setTimeout(() => this.start(), 2000);
                    } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        const delay = Math.min(3000 * this.reconnectAttempts, 20000);
                        setTimeout(() => this.start(), delay);
                    } else {
                        this.handleLogout();
                        this.reconnectAttempts = 0;
                        setTimeout(() => this.start(), 10000);
                    }
                }

                if (connection === 'connecting') {
                    this.emit('connecting');
                }
            });

            // Incoming messages
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
                        console.log(`📥 Message from ${sender}: ${text}`);
                    }
                } catch (err) {
                    console.error('Error handling message:', err.message);
                }
            });

        } catch (error) {
            console.error('❌ Failed to start bot:', error.message);
            const delay = Math.min(5000 * this.reconnectAttempts, 30000);
            setTimeout(() => this.start(), delay);
        }
    }

    startKeepAlive() {
        this.clearIntervals();
        this.keepAliveInterval = setInterval(async () => {
            if (this.sock && this.isConnected) {
                try {
                    await this.sock.sendPresenceUpdate('available');
                } catch { }
            }
        }, 25000);
    }

    clearIntervals() {
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
        this.keepAliveInterval = null;
        this.connectionTimeout = null;
    }

    async sendMessage(number, message) {
        if (!this.sock || !this.isConnected) {
            throw new Error('Bot not connected.');
        }

        const clean = number.replace(/\D/g, '');
        const jid = `${clean}@s.whatsapp.net`;
        const sent = await this.sock.sendMessage(jid, { text: message });
        return { success: true, id: sent.key.id, number: clean };
    }

    handleLogout() {
        this.clearIntervals();
        this.isConnected = false;

        if (fs.existsSync(this.authFolder)) {
            fs.rmSync(this.authFolder, { recursive: true, force: true });
        }

        this.emit('logout');
    }

    async restart() {
        this.clearIntervals();
        this.isConnected = false;

        if (this.sock) {
            try { await this.sock.end(); } catch { }
            this.sock = null;
        }

        setTimeout(() => this.start(), 2000);
    }

    cleanup() {
        this.clearIntervals();
        if (this.sock) {
            try { this.sock.end(); } catch { }
        }
    }
}
