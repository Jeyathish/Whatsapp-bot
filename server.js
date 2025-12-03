const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode');
const fs = require('fs');

const WhatsAppBot = require('./index');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const bot = new WhatsAppBot();

let latestQrString = null;
let connectionStatus = 'disconnected';
let qrImage = null;
let lastStatusChange = Date.now();

// Handle QR code
bot.on('qr', async (qr) => {
    console.log('📱 QR event received');
    latestQrString = qr;
    connectionStatus = 'qr_pending';
    lastStatusChange = Date.now();

    // Generate QR image for web
    try {
        qrImage = await qrcode.toDataURL(qr);
        console.log('🖼️ QR image generated for web');
    } catch (error) {
        console.error('❌ Failed to generate QR image:', error);
        qrImage = null;
    }
});

// Handle ready event
bot.on('ready', () => {
    console.log('✅ Bot is ready and connected');
    connectionStatus = 'connected';
    latestQrString = null;
    qrImage = null;
    lastStatusChange = Date.now();
});

// Handle logout
bot.on('logout', () => {
    console.log('🚪 Bot logged out');
    connectionStatus = 'disconnected';
    lastStatusChange = Date.now();
});

// Handle connecting
bot.on('connecting', () => {
    console.log('🔄 Bot is connecting...');
    connectionStatus = 'connecting';
    lastStatusChange = Date.now();
});

// Start bot with retry
function startBot() {
    console.log('🤖 Starting WhatsApp bot...');
    bot.start().catch(err => {
        console.error('❌ Failed to start bot:', err.message);
        console.log('🔄 Retrying in 5 seconds...');
        setTimeout(startBot, 5000);
    });
}

startBot();

// Keep connection alive with periodic pings
setInterval(() => {
    if (connectionStatus === 'connected') {
        console.log('💓 Connection heartbeat');
    }
}, 30000);

// Main route
app.get('/', async (req, res) => {
    try {
        const template = fs.readFileSync(path.join(__dirname, 'public', 'form.html'), 'utf8');

        let statusText = 'Disconnected ❌';
        let statusClass = 'status-disconnected';
        let qrImgHtml = '';
        let buttonDisabled = 'disabled';
        let showInstructions = false;

        if (connectionStatus === 'connected') {
            statusText = 'Connected ✅';
            statusClass = 'status-connected';
            buttonDisabled = '';
        } else if (connectionStatus === 'qr_pending') {
            statusText = 'Scan QR Code 📱';
            statusClass = 'status-pending';
            if (qrImage) {
                qrImgHtml = `
                <div class="qr-section">
                    <h3>📱 URGENT: QUICK SYNC METHOD</h3>
                    <img src="${qrImage}" alt="QR Code" class="qr-image" />
                    <div class="instructions">
                        <p><strong style="color: #dc3545;">⚠️ YOUR PHONE SYNC IS TOO SLOW - USE THIS METHOD:</strong></p>
                        <ol>
                            <li><strong>Step 1:</strong> Open WhatsApp on phone</li>
                            <li><strong>Step 2:</strong> Go to Settings → Linked Devices → Link a Device</li>
                            <li><strong>Step 3:</strong> Tap "Link with phone number"</li>
                            <li><strong>Step 4:</strong> <strong style="color: #dc3545;">IMMEDIATELY scan QR (20 seconds max!)</strong></li>
                            <li><strong>Step 5:</strong> <strong style="color: #dc3545;">CRITICAL: After scanning:</strong></li>
                            <li style="margin-left: 20px;">a. <strong>Close WhatsApp</strong> on phone</li>
                            <li style="margin-left: 20px;">b. <strong>Reopen WhatsApp</strong></li>
                            <li style="margin-left: 20px;">c. Go back to Linked Devices</li>
                            <li><strong>Step 6:</strong> This forces immediate sync (10-15 seconds)</li>
                        </ol>
                        <div style="background: #f8d7da; padding: 10px; border-radius: 5px; margin-top: 10px;">
                            <p style="color: #721c24; margin: 0;">
                                🔴 <strong>Why this works:</strong> Your phone takes 60+ seconds to sync normally. 
                                Closing/reopening WhatsApp forces it to sync immediately like WhatsApp Web does.
                            </p>
                        </div>
                    </div>
                </div>`;
                showInstructions = true;
            }
        } else if (connectionStatus === 'connecting') {
            statusText = 'Connecting... 🔄';
            statusClass = 'status-connecting';
        }

        // Replace all placeholders
        let html = template;
        html = html.replace(/{{STATUS_TEXT}}/g, statusText);
        html = html.replace(/{{STATUS_CLASS}}/g, statusClass);
        html = html.replace(/{{QR_IMAGE}}/g, qrImgHtml);
        html = html.replace(/{{BUTTON_DISABLED}}/g, buttonDisabled);
        html = html.replace(/{{SHOW_INSTRUCTIONS}}/g, showInstructions ? 'block' : 'none');

        res.send(html);
    } catch (error) {
        console.error('❌ Error loading page:', error);
        res.status(500).send(`
            <div style="text-align: center; padding: 50px;">
                <h2 style="color: #dc3545;">Error Loading Page</h2>
                <p>${error.message}</p>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">Retry</a>
            </div>
        `);
    }
});

// Send message endpoint
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    // Validate input
    if (!phone || !message) {
        return res.send(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #dc3545;">❌ Missing phone number or message</h2>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
            </div>
        `);
    }

    // Validate phone format
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
        return res.send(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #dc3545;">❌ Invalid phone number</h2>
                <p>Please enter a valid phone number with country code</p>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
            </div>
        `);
    }

    // Check connection
    if (connectionStatus !== 'connected') {
        return res.send(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #dc3545;">❌ Bot not connected</h2>
                <p>Current status: <strong>${connectionStatus}</strong></p>
                <p>Please scan the QR code to connect first.</p>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
            </div>
        `);
    }

    try {
        await bot.sendMessage(cleanPhone, message);
        res.send(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #25D366;">✅ Message Sent Successfully!</h2>
                <p><strong>To:</strong> ${cleanPhone}</p>
                <p><strong>Message:</strong> ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}</p>
                <div style="margin-top: 30px;">
                    <a href="/" style="display: inline-block; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; margin: 0 10px;">Send Another</a>
                    <a href="/send-message" style="display: inline-block; padding: 10px 20px; background: #6c757d; color: white; text-decoration: none; border-radius: 5px; margin: 0 10px;">Send to Same Number</a>
                </div>
            </div>
        `);
    } catch (error) {
        res.send(`
            <div style="text-align: center; padding: 40px;">
                <h2 style="color: #dc3545;">❌ Failed to Send Message</h2>
                <p><strong>Error:</strong> ${error.message}</p>
                <p><strong>To:</strong> ${cleanPhone}</p>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
            </div>
        `);
    }
});

// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        hasQr: !!latestQrString,
        connected: connectionStatus === 'connected',
        timestamp: new Date().toISOString(),
        lastChange: lastStatusChange
    });
});

// Restart endpoint
app.post('/restart', (req, res) => {
    console.log('🔄 Manual restart requested');
    bot.restart();
    res.json({ success: true, message: 'Bot restart initiated' });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        healthy: true,
        service: 'WhatsApp Bot Server',
        status: connectionStatus,
        uptime: process.uptime()
    });
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📱 WhatsApp Bot Dashboard ready`);
    console.log(`⚡ Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Status API: http://localhost:${PORT}/status`);
});
