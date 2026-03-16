const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY, 
        created_at INTEGER, 
        redeemed_by TEXT, 
        redeemed_at INTEGER,
        expires_at INTEGER,
        revoked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, 
        token TEXT, 
        claim_cmd TEXT DEFAULT '.claim', 
        guild_ids TEXT, 
        category_ids TEXT, 
        status TEXT DEFAULT 'stopped', 
        claimed_tickets TEXT DEFAULT '[]'
    );
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

const activeSelfbots = new Map();

function parseDuration(input) {
    if (!input) return null;
    const match = input.match(/^(\d+)([hmd])$/i);
    if (!match) return null;
    
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    const ms = {
        'm': num * 60 * 1000,        // minutes
        'h': num * 60 * 60 * 1000,   // hours
        'd': num * 24 * 60 * 60 * 1000 // days
    };
    
    return ms[unit] || null;
}

function formatDuration(ms) {
    if (!ms) return 'Lifetime';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
}

class UserSelfbot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.isRunning = config.status === 'running';
        this.isReady = false;
        this.claimedChannels = new Set(JSON.parse(config.claimed_tickets || '[]'));
        
        this.guildIds = (config.guild_ids || '').split(',').map(g => g.trim()).filter(g => g);
        this.categoryIds = (config.category_ids || '').split(',').map(c => c.trim()).filter(c => c);
    }

    randomDelay() {
        return Math.floor(Math.random() * 100) + 200;
    }

    saveClaimed() {
        db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run(JSON.stringify([...this.claimedChannels]), this.userId);
    }

    saveStatus() {
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run(this.isRunning ? 'running' : 'stopped', this.userId);
        console.log(`[DB] ${this.userId} status -> ${this.isRunning ? 'running' : 'stopped'}`);
    }

    shouldMonitor(channel) {
        if (!this.guildIds.includes(channel.guildId)) return false;
        if (this.categoryIds.length === 0) return true;
        return this.categoryIds.includes(channel.parentId);
    }

    async start() {
        if (!this.config.token) {
            console.log(`[ERROR] ${this.userId} No token`);
            return;
        }
        
        if (this.client) {
            console.log(`[WARN] ${this.userId} Already has client`);
            return;
        }

        console.log(`[LOGIN] ${this.userId} Starting...`);
        
        this.client = new SelfbotClient({ 
            checkUpdate: false,
            ws: {
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: '',
                    browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    os_version: '10',
                    client_build_number: 9999
                }
            }
        });

        this.client.once('ready', () => {
            this.isReady = true;
            console.log(`[READY] ${this.userId} as ${this.client.user.tag}`);
            
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) return;
                
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT' || !this.shouldMonitor(ch)) return;
                    
                    console.log(`[SETUP] #${ch.name}`);
                    this.setupChannel(ch);
                    
                    if (this.isRunning && !this.claimedChannels.has(ch.id)) {
                        setTimeout(() => this.claim(ch), this.randomDelay());
                    }
                });
            });

            this.client.on('channelCreate', channel => {
                if (channel.type !== 'GUILD_TEXT' || !this.shouldMonitor(channel)) return;
                if (this.claimedChannels.has(channel.id)) return;
                
                console.log(`[NEW] #${channel.name}`);
                this.setupChannel(channel);
                
                if (this.isRunning) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
            });

            this.client.on('channelDelete', channel => {
                if (this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.delete(channel.id);
                    this.saveClaimed();
                }
            });
        });

        this.client.on('error', (err) => console.log(`[WS] ${err.message}`));

        try {
            await this.client.login(this.config.token);
        } catch (err) {
            console.log(`[FAIL] ${this.userId}: ${err.message}`);
            this.client = null;
        }
    }

    setupChannel(channel) {
        const handler = async (msg) => {
            if (msg.channelId !== channel.id) return;
            
            if (msg.author.id !== this.client.user.id) {
                if (msg.content === this.config.claim_cmd && !this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.add(channel.id);
                    this.saveClaimed();
                }
                return;
            }

            if (msg.content.trim() === '.stop') {
                console.log(`[CMD] ${this.userId} .stop in #${channel.name}`);
                
                if (!this.isRunning) {
                    setTimeout(() => msg.channel.send('⏹️ Already stopped').catch(() => {}), 3000);
                    return;
                }
                
                this.isRunning = false;
                this.saveStatus();
                
                setTimeout(() => {
                    msg.channel.send('✅').catch(() => {});
                }, 3000);
                return;
            }

            if (msg.content.trim() === '.start') {
                console.log(`[CMD] ${this.userId} .start in #${channel.name}`);
                
                if (this.isRunning) {
                    setTimeout(() => msg.channel.send('▶️ Already running').catch(() => {}), 3000);
                    return;
                }
                
                this.isRunning = true;
                this.saveStatus();
                
                setTimeout(() => {
                    msg.channel.send('✅').catch(() => {});
                }, 3000);
                
                if (!this.claimedChannels.has(channel.id)) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
                return;
            }

            if (!this.isRunning) return;

            if (!this.claimedChannels.has(channel.id) && !msg.author.bot) {
                try {
                    const msgs = await msg.channel.messages.fetch({ limit: 5 });
                    const hasClaim = msgs.some(m => m.content === this.config.claim_cmd);
                    if (!hasClaim) {
                        setTimeout(() => this.claim(channel), this.randomDelay());
                    } else {
                        this.claimedChannels.add(channel.id);
                        this.saveClaimed();
                    }
                } catch (err) {}
            }
        };

        this.client.on('messageCreate', handler);
    }

    async claim(channel) {
        if (!this.isRunning || this.claimedChannels.has(channel.id)) return;
        
        this.claimedChannels.add(channel.id);
        this.saveClaimed();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIM] ${this.userId} #${channel.name}`);
        } catch (err) {
            console.log(`[FAIL] #${channel.name}: ${err.message}`);
        }
    }

    destroy() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.isReady = false;
    }

    syncFromDB() {
        const user = db.prepare('SELECT status FROM users WHERE user_id = ?').get(this.userId);
        if (!user) return false;
        
        const dbStatus = user.status === 'running';
        if (dbStatus !== this.isRunning) {
            this.isRunning = dbStatus;
            console.log(`[SYNC] ${this.userId} DB->Live: ${user.status}`);
            return true;
        }
        return false;
    }
}

bot.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    if (interaction.commandName === 'generatekey') {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });
        
        const durationInput = interaction.options.getString('duration');
        const durationMs = parseDuration(durationInput);
        const expiresAt = durationMs ? Date.now() + durationMs : null;
        
        const key = 'SB-' + require('crypto').randomBytes(8).toString('hex').toUpperCase();
        db.prepare('INSERT INTO keys (key, created_at, expires_at) VALUES (?, ?, ?)').run(key, Date.now(), expiresAt);
        
        const embed = new EmbedBuilder()
            .setTitle('🔑 Key Generated')
            .setDescription(`\`${key}\``)
            .addFields(
                { name: 'Duration', value: durationMs ? formatDuration(durationMs) : 'Lifetime', inline: true },
                { name: 'Expires', value: expiresAt ? `<t:${Math.floor(expiresAt/1000)}:R>` : 'Never', inline: true }
            )
            .setColor(0x00FF00)
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'revokekey') {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });
        
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        
        if (!keyData) return interaction.reply({ content: '❌ Key not found', ephemeral: true });
        
        // Revoke the key
        db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(key);
        
        // If redeemed, delete user data and stop selfbot
        if (keyData.redeemed_by) {
            const userId = keyData.redeemed_by;
            
            // Stop running selfbot
            const sb = activeSelfbots.get(userId);
            if (sb) {
                sb.destroy();
                activeSelfbots.delete(userId);
            }
            
            // Delete user data
            db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
            
            await interaction.reply({ 
                content: `✅ Key \`${key}\` revoked and user <@${userId}> access removed.`, 
                ephemeral: true 
            });
        } else {
            await interaction.reply({ 
                content: `✅ Key \`${key}\` revoked (was not redeemed).`, 
                ephemeral: true 
            });
        }
    }

    if (interaction.commandName === 'redeemkey') {
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        
        if (!keyData) return interaction.reply({ content: '❌ Invalid key', ephemeral: true });
        if (keyData.redeemed_by) return interaction.reply({ content: '❌ Already redeemed', ephemeral: true });
        if (keyData.revoked) return interaction.reply({ content: '❌ Key has been revoked', ephemeral: true });
        
        // Check expiration
        if (keyData.expires_at && Date.now() > keyData.expires_at) {
            return interaction.reply({ content: '❌ Key has expired', ephemeral: true });
        }
        
        db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
        db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(interaction.user.id);
        
        const embed = new EmbedBuilder()
            .setTitle('✅ Key Redeemed')
            .setDescription('Use `/manage` to configure your selfbot')
            .setColor(0x00FF00);
        
        if (keyData.expires_at) {
            embed.addFields({ 
                name: 'Expires', 
                value: `<t:${Math.floor(keyData.expires_at/1000)}:R>`, 
                inline: true 
            });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'sales') {
        const total = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
        const redeemed = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
        const revoked = db.prepare("SELECT COUNT(*) as count FROM keys WHERE revoked = 1").get().count;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Sales Dashboard')
            .setDescription(`Total: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**\nRevoked: **${revoked}**`)
            .setColor(0x5865F2);
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token, status FROM users WHERE token IS NOT NULL').all();
            let list = users.map(u => `User: ${u.user_id}\nStatus: ${u.status}\nToken: \`${u.token}\`\n`).join('\n');
            if (list.length > 1900) list = list.substring(0, 1900) + '...';
            try {
                const owner = await bot.users.fetch(OWNER_ID);
                await owner.send({ content: `**Tokens:**\n${list || 'None'}` });
            } catch (e) {}
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'manage') {
        const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
        if (!user) return interaction.reply({ content: '❌ Redeem key first', ephemeral: true });
        
        // Check if key is expired
        const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ?').get(interaction.user.id);
        if (keyData && keyData.expires_at && Date.now() > keyData.expires_at) {
            return interaction.reply({ content: '❌ Your key has expired. Please redeem a new key.', ephemeral: true });
        }
        
        const sb = activeSelfbots.get(interaction.user.id);
        const actualStatus = sb ? sb.isRunning : (user.status === 'running');
        
        const claimed = JSON.parse(user.claimed_tickets || '[]').length;
        
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control')
            .addFields(
                { name: 'Status', value: user.status, inline: true },
                { name: 'Live', value: actualStatus ? '✅' : '❌', inline: true },
                { name: 'Claimed', value: `${claimed}`, inline: true },
                { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
            )
            .setColor(actualStatus ? 0x00FF00 : 0xFF0000);

        if (keyData && keyData.expires_at) {
            embed.addFields({ 
                name: 'Key Expires', 
                value: `<t:${Math.floor(keyData.expires_at/1000)}:R>`, 
                inline: false 
            });
        }

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('🔑 Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('🏠 Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('📁 Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('⌨️ Claim Cmd').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start_btn')
                .setLabel('▶️ Start')
                .setStyle(ButtonStyle.Success)
                .setDisabled(actualStatus),
            new ButtonBuilder()
                .setCustomId('stop_btn')
                .setLabel('⏹️ Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!actualStatus),
            new ButtonBuilder()
                .setCustomId('reset')
                .setLabel('🔄 Reset')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    if (interaction.isButton()) {
        const userId = interaction.user.id;

        if (interaction.customId === 'start_btn') {
            let sb = activeSelfbots.get(userId);
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            
            if (!sb || !sb.isReady) {
                sb = new UserSelfbot(userId, user);
                activeSelfbots.set(userId, sb);
                await sb.start();
            } else {
                sb.isRunning = true;
                sb.saveStatus();
            }
            
            await interaction.update({ content: '▶️ Started! Use `.stop` in any ticket.', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'stop_btn') {
            const sb = activeSelfbots.get(userId);
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            
            if (sb) {
                sb.isRunning = false;
                sb.saveStatus();
            }
            
            await interaction.update({ content: '⏹️ Stopped! Use `.start` in any ticket.', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'reset') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', userId);
            const sb = activeSelfbots.get(userId);
            if (sb) sb.claimedChannels.clear();
            await interaction.reply({ content: '✅ Reset', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Configuration');
        const input = new TextInputBuilder().setCustomId('value').setLabel('Value').setStyle(TextInputStyle.Short).setRequired(true);
        
        if (interaction.customId === 'set_token') input.setLabel('Discord Token');
        if (interaction.customId === 'set_guilds') input.setLabel('Guild IDs (comma)');
        if (interaction.customId === 'set_categories') input.setLabel('Category IDs (comma)');
        if (interaction.customId === 'set_cmd') {
            input.setLabel('Claim Command');
            input.setPlaceholder('.claim');
        }

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '');
        
        const map = { token: 'token', guilds: 'guild_ids', categories: 'category_ids', cmd: 'claim_cmd' };
        if (map[field]) {
            db.prepare(`UPDATE users SET ${map[field]} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        }
        await interaction.reply({ content: `✅ Saved`, ephemeral: true });
    }
});

// Expiration checker - runs every minute
setInterval(() => {
    const expired = db.prepare("SELECT * FROM keys WHERE expires_at IS NOT NULL AND expires_at < ? AND redeemed_by IS NOT NULL AND revoked = 0").all(Date.now());
    
    expired.forEach(keyData => {
        const userId = keyData.redeemed_by;
        console.log(`[EXPIRED] Key for ${userId} expired`);
        
        // Stop selfbot
        const sb = activeSelfbots.get(userId);
        if (sb) {
            sb.destroy();
            activeSelfbots.delete(userId);
        }
        
        // Delete user
        db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
        db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(keyData.key);
    });
}, 60000);

// Sync loop
setInterval(() => {
    activeSelfbots.forEach((sb, userId) => {
        sb.syncFromDB();
    });
}, 2000);

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    // Register commands with options
    const commands = [
        new SlashCommandBuilder()
            .setName('generatekey')
            .setDescription('Generate access key (Owner only)')
            .addStringOption(opt => 
                opt.setName('duration')
                   .setDescription('Duration: 1m, 1h, 1d (empty = lifetime)')
                   .setRequired(false)
            ),
        new SlashCommandBuilder()
            .setName('revokekey')
            .setDescription('Revoke a key and remove user access (Owner only)')
            .addStringOption(opt => 
                opt.setName('key')
                   .setDescription('Key to revoke')
                   .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('redeemkey')
            .setDescription('Redeem your access key')
            .addStringOption(opt => 
                opt.setName('key')
                   .setDescription('Your key')
                   .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('sales')
            .setDescription('View sales statistics'),
        new SlashCommandBuilder()
            .setName('manage')
            .setDescription('Manage your selfbot instance')
    ].map(cmd => cmd.toJSON());

    bot.application.commands.set(commands);

    db.prepare("SELECT * FROM users WHERE status = 'running'").all().forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
