const { Client, Intents } = require('discord.js-selfbot-v13');

const TOKEN = process.env.TOKEN;
const TARGET_GUILD_ID = process.env.GUILD_ID || '1482823113157644361';
const TICKET_CATEGORY_ID = process.env.CATEGORY;
const ANTI_BAN_DELAY = { min: 200, max: 300 };

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES
    ],
    ws: {
        properties: getSuperProperties()
    },
    restRequestTimeout: 60000,
    retryLimit: 3,
    checkUpdate: false
});

let isRunning = true;
let claimedChannels = new Set();

function getSuperProperties() {
    return {
        os: 'iOS',
        browser: 'Discord iOS',
        device: 'iPhone11,2',
        system_locale: 'nb-NO',
        browser_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Discord/78.0 (iPhone11,2; 14.4; Norway; nb)',
        browser_version: '78.0',
        os_version: '14.4',
        client_build_number: 110451,
        client_version: '0.0.1',
        country_code: 'NO',
        geo_ordered_rtc_regions: ['norway', 'russia', 'germany'],
        timezone_offset: 60,
        locale: 'nb-NO',
        client_city: 'Oslo',
        client_region: 'Oslo',
        client_postal_code: '1255',
        client_district: 'Holmlia',
        client_country: 'Norway',
        client_latitude: 59.83,
        client_longitude: 10.80,
        client_isp: 'Telenor Norge AS',
        client_timezone: 'Europe/Oslo',
        client_architecture: 'arm64',
        client_app_platform: 'mobile',
        client_distribution_type: 'app_store'
    };
}

client.once('ready', async () => {
    console.log(`[READY] ${client.user.tag}`);
    console.log(`[GUILD] ${TARGET_GUILD_ID}`);
    console.log(`[CATEGORY] ${TICKET_CATEGORY_ID || 'All'}`);
    
    const guild = client.guilds.cache.get(TARGET_GUILD_ID);
    if (!guild) {
        console.log('[ERROR] Guild not found');
        return;
    }
    
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
    return Math.floor(Math.random() * (ANTI_BAN_DELAY.max - ANTI_BAN_DELAY.min + 1)) + ANTI_BAN_DELAY.min;
}

async function sendClaim(channel) {
    if (!isRunning || claimedChannels.has(channel.id)) return;
    
    try {
        await channel.sendTyping();
        await new Promise(r => setTimeout(r, randomDelay()));
        
        await channel.send('.claim');
        console.log(`[CLAIM] #${channel.name}`);
        claimedChannels.add(channel.id);
        
        const collector = channel.createMessageCollector({ 
            filter: m => m.author.id === client.user.id || m.content.includes('.unclaim'),
            time: 300000 
        });
        
        collector.on('collect', m => {
            if (m.content === '.unclaim' || m.content.includes('unclaimed')) {
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
        
        if (isRunning) {
            setTimeout(() => sendClaim(channel), randomDelay());
        }
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

setInterval(() => {
    if (!client.user) return;
    const statuses = ['online', 'idle', 'dnd'];
    client.user.setStatus(statuses[Math.floor(Math.random() * statuses.length)]);
}, 300000);

client.on('error', err => console.log(`[WS] ${err.message}`));
client.on('disconnect', () => setTimeout(() => client.login(TOKEN), 5000));

client.login(TOKEN).catch(err => {
    console.log(`[LOGIN] ${err.message}`);
    process.exit(1);
});
