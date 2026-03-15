const { Client } = require('discord.js-selfbot-v13');

const TOKEN = process.env.TOKEN;
const TARGET_GUILD_ID = process.env.GUILD_ID || '1420535190500933713';
const TICKET_CATEGORY_ID = process.env.CATEGORY;

console.log('[INIT] Starting...');

if (!TOKEN) {
    console.log('[FATAL] No token');
    process.exit(1);
}

const client = new Client({
    checkUpdate: false
});

let isRunning = true;
let claimedChannels = new Set();

client.once('ready', () => {
    console.log(`[READY] ${client.user.tag}`);
    
    const guild = client.guilds.cache.get(TARGET_GUILD_ID);
    if (!guild) {
        console.log('[ERROR] Guild not found');
        return;
    }
    
    console.log(`[GUILD] ${guild.name}`);
    
    if (TICKET_CATEGORY_ID) {
        const channels = guild.channels.cache.filter(
            ch => ch.parentId === TICKET_CATEGORY_ID && ch.type === 'GUILD_TEXT'
        );
        console.log(`[INIT] ${channels.size} tickets`);
        channels.forEach(ch => monitorChannel(ch));
    }
    
    startMonitoring(guild);
});

function randomDelay() {
    return Math.floor(Math.random() * 100) + 200;
}

async function sendClaim(channel) {
    if (!isRunning || claimedChannels.has(channel.id)) return;
    
    try {
        await new Promise(r => setTimeout(r, randomDelay()));
        await channel.send('.claim');
        console.log(`[CLAIM] #${channel.name}`);
        claimedChannels.add(channel.id);
        
        const collector = channel.createMessageCollector({ 
            filter: m => m.author.id === client.user.id || m.content.includes('.unclaim'),
            time: 300000 
        });
        
        collector.on('collect', m => {
            if (m.content.includes('unclaim')) {
                claimedChannels.delete(channel.id);
                console.log(`[UNCLAIM] #${channel.name}`);
                collector.stop();
            }
        });
        
    } catch (err) {
        console.log(`[ERROR] ${err.message}`);
    }
}

function startMonitoring(guild) {
    client.on('channelCreate', channel => {
        if (channel.guildId !== TARGET_GUILD_ID) return;
        if (channel.type !== 'GUILD_TEXT') return;
        if (TICKET_CATEGORY_ID && channel.parentId !== TICKET_CATEGORY_ID) return;
        
        console.log(`[NEW] #${channel.name}`);
        monitorChannel(channel);
        
        if (isRunning) setTimeout(() => sendClaim(channel), randomDelay());
    });
    
    client.on('channelDelete', channel => {
        if (claimedChannels.has(channel.id)) {
            claimedChannels.delete(channel.id);
            console.log(`[DELETE] #${channel.name}`);
        }
    });
}

function monitorChannel(channel) {
    client.on('messageCreate', (message) => {
        if (message.channelId !== channel.id) return;
        if (!isRunning) return;
        
        if (message.content === '.claim' && message.author.id !== client.user.id) {
            claimedChannels.add(channel.id);
            console.log(`[BLOCKED] #${channel.name}`);
            return;
        }
        
        if (message.content === '.unclaim') {
            claimedChannels.delete(channel.id);
            console.log(`[OPEN] #${channel.name}`);
            setTimeout(() => sendClaim(channel), randomDelay());
            return;
        }
        
        if (!claimedChannels.has(channel.id) && !message.author.bot) {
            channel.messages.fetch({ limit: 5 }).then(msgs => {
                if (!msgs.some(m => m.content === '.claim') && isRunning) {
                    setTimeout(() => sendClaim(channel), randomDelay());
                }
            }).catch(() => {});
        }
    });
}

client.on('messageCreate', message => {
    if (message.author.id !== client.user.id) return;
    
    if (message.content === '.stop') {
        isRunning = false;
        message.reply('⏹️ Stopped').catch(() => {});
    }
    
    if (message.content === '.start') {
        isRunning = true;
        message.reply('▶️ Started').catch(() => {});
    }
    
    if (message.content === '.status') {
        message.reply(`📊 ${isRunning ? 'RUNNING' : 'STOPPED'} | ${claimedChannels.size}`).catch(() => {});
    }
});

client.on('error', err => console.log(`[WS] ${err.message}`));

client.login(TOKEN).catch(err => {
    console.log(`[LOGIN] ${err.message}`);
    process.exit(1);
});
