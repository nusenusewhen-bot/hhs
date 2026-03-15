const { Client, GatewayIntentBits, Partials, Events } = require('discord.js-selfbot-v13');

const TOKEN = process.env.TOKEN;
const TARGET_GUILD_ID = process.env.GUILD_ID || '1482823113157644361';
const TICKET_CATEGORY_ID = process.env.CATEGORY; // Category ID from variables
const CLAIM_COOLDOWN = 250;
const ANTI_BAN_DELAY = { min: 200, max: 300 };

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel],
    ws: {
        properties: getSuperProperties()
    },
    restRequestTimeout: 60000,
    retryLimit: 3
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

client.once(Events.ClientReady, async () => {
    console.log(`[READY] Logged in as ${client.user.tag}`);
    console.log(`[CONFIG] Guild: ${TARGET_GUILD_ID}`);
    console.log(`[CATEGORY] ${TICKET_CATEGORY_ID ? 'Monitoring: ' + TICKET_CATEGORY_ID : 'No category set - monitoring all channels'}`);
    console.log(`[ANTIBAN] Delay: ${ANTI_BAN_DELAY.min}-${ANTI_BAN_DELAY.max}ms`);
    console.log(`[DEVICE] iPhone 11 | Oslo, Norway | Holmlia 1255`);
    
    const guild = client.guilds.cache.get(TARGET_GUILD_ID);
    if (!guild) {
        console.log('[ERROR] Guild not found');
        return;
    }
    
    console.log(`[GUILD] Connected to ${guild.name}`);
    
    // Monitor existing channels in category
    if (TICKET_CATEGORY_ID) {
        const categoryChannels = guild.channels.cache.filter(
            ch => ch.parentId === TICKET_CATEGORY_ID && ch.isTextBased()
        );
        console.log(`[INIT] Found ${categoryChannels.size} existing ticket channels`);
        categoryChannels.forEach(ch => monitorChannel(ch));
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
        
        const msg = await channel.send('.claim');
        console.log(`[CLAIM] Sent in #${channel.name} (${channel.id})`);
        
        claimedChannels.add(channel.id);
        
        const filter = m => m.author.id === client.user.id || m.content.includes('.unclaim');
        const collector = channel.createMessageCollector({ filter, time: 300000 });
        
        collector.on('collect', m => {
            if (m.content === '.unclaim' || m.content.includes('unclaimed')) {
                claimedChannels.delete(channel.id);
                console.log(`[UNCLAIM] Reset for #${channel.name}`);
                collector.stop();
            }
        });
        
    } catch (err) {
        console.log(`[ERROR] Failed to claim in #${channel.name}: ${err.message}`);
    }
}

function startMonitoring(guild) {
    client.on(Events.ChannelCreate, channel => {
        if (channel.guildId !== TARGET_GUILD_ID) return;
        if (!channel.isTextBased()) return;
        
        // Only claim if in target category or no category set
        if (TICKET_CATEGORY_ID && channel.parentId !== TICKET_CATEGORY_ID) {
            return;
        }
        
        console.log(`[NEW TICKET] #${channel.name} in category ${channel.parentId}`);
        monitorChannel(channel);
        
        if (isRunning) {
            setTimeout(() => sendClaim(channel), randomDelay());
        }
    });
    
    client.on(Events.ChannelDelete, channel => {
        if (claimedChannels.has(channel.id)) {
            claimedChannels.delete(channel.id);
            console.log(`[DELETE] Cleaned up #${channel.name}`);
        }
    });
    
    client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
        // If channel moved out of category, stop monitoring
        if (TICKET_CATEGORY_ID && oldChannel.parentId === TICKET_CATEGORY_ID && newChannel.parentId !== TICKET_CATEGORY_ID) {
            claimedChannels.delete(newChannel.id);
            console.log(`[MOVED] #${newChannel.name} left category`);
        }
    });
}

function monitorChannel(channel) {
    if (!channel.isTextBased() || channel.isDMBased()) return;
    
    client.on(Events.MessageCreate, (message) => {
        if (message.channelId !== channel.id) return;
        if (!isRunning) return;
        
        if (message.content === '.claim' && message.author.id !== client.user.id) {
            claimedChannels.add(channel.id);
            console.log(`[BLOCKED] Someone claimed #${channel.name}`);
            return;
        }
        
        if (message.content === '.unclaim') {
            claimedChannels.delete(channel.id);
            console.log(`[OPEN] #${channel.name} available again`);
            setTimeout(() => sendClaim(channel), randomDelay());
            return;
        }
        
        if (!claimedChannels.has(channel.id) && !message.author.bot) {
            channel.messages.fetch({ limit: 5 }).then(messages => {
                const hasClaim = messages.some(m => m.content === '.claim');
                if (!hasClaim && isRunning) {
                    setTimeout(() => sendClaim(channel), randomDelay());
                }
            }).catch(() => {});
        }
    });
}

client.on(Events.MessageCreate, message => {
    if (message.author.id !== client.user.id) return;
    
    if (message.content === '.stop') {
        isRunning = false;
        console.log('[CONTROL] Stopped');
        message.reply('⏹️ Stopped').catch(() => {});
    }
    
    if (message.content === '.start') {
        isRunning = true;
        console.log('[CONTROL] Started');
        message.reply('▶️ Started').catch(() => {});
    }
    
    if (message.content === '.status') {
        const catStatus = TICKET_CATEGORY_ID ? `Category: ${TICKET_CATEGORY_ID}` : 'All channels';
        message.reply(`📊 ${isRunning ? 'RUNNING' : 'STOPPED'}\n${catStatus}\nClaimed: ${claimedChannels.size}`).catch(() => {});
    }
});

setInterval(() => {
    if (!client.user) return;
    const statuses = ['online', 'idle', 'dnd'];
    client.user.setPresence({ status: statuses[Math.floor(Math.random() * statuses.length)] });
}, 300000);

client.on(Events.Error, error => console.log(`[WS ERROR] ${error.message}`));
client.on(Events.Disconnect, () => {
    console.log('[DISCONNECT] Reconnecting...');
    setTimeout(() => client.login(TOKEN), 5000);
});

client.login(TOKEN).catch(err => {
    console.log(`[LOGIN ERROR] ${err.message}`);
    process.exit(1);
});
