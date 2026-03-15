const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, claim_cmd TEXT DEFAULT '.claim', guild_ids TEXT, category_ids TEXT, status TEXT DEFAULT 'stopped', claimed_tickets TEXT DEFAULT '[]');
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

const activeSelfbots = new Map();

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
    }

    shouldMonitor(channel) {
        if (!this.guildIds.includes(channel.guildId)) return false;
        if (this.categoryIds.length === 0) return true;
        return this.categoryIds.includes(channel.parentId);
    }

    async start() {
        if (!this.config.token) {
            console.log(`[ERROR] ${this.userId} No token provided`);
            return;
        }
        
        if (this.client) {
            console.log(`[WARN] ${this.userId} Already has client`);
            return;
        }

        console.log(`[LOGIN] ${this.userId} Attempting login...`);
        
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
            console.log(`[READY] ${this.userId} Logged in as ${this.client.user.tag}`);
            
            // Check guilds
            console.log(`[GUILDS] ${this.userId} Available:`, this.client.guilds.cache.map(g => `${g.name}(${g.id})`).join(', '));
            
            // Setup existing channels
            let monitoredCount = 0;
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) {
                    console.log(`[SKIP] Guild ${guild.id} not in list`);
                    return;
                }
                
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT') return;
                    if (!this.shouldMonitor(ch)) {
                        console.log(`[SKIP] Channel ${ch.name} - category mismatch`);
                        return;
                    }
                    
                    console.log(`[SETUP] Existing #${ch.name} (${ch.id})`);
                    this.setupChannel(ch);
                    monitoredCount++;
                    
                    if (this.isRunning && !this.claimedChannels.has(ch.id)) {
                        console.log(`[AUTO] Will claim #${ch.name}`);
                        setTimeout(() => this.claim(ch), this.randomDelay());
                    }
                });
            });
            
            console.log(`[INIT] ${this.userId} Monitoring ${monitoredCount} channels`);

            // Listen for new channels
            this.client.on('channelCreate', channel => {
                console.log(`[EVENT] channelCreate: #${channel.name} type=${channel.type} guild=${channel.guildId}`);
                
                if (channel.type !== 'GUILD_TEXT') {
                    console.log(`[SKIP] Not a text channel`);
                    return;
                }
                
                if (!this.shouldMonitor(channel)) {
                    console.log(`[SKIP] Category/Guild mismatch. Parent: ${channel.parentId}, Guild: ${channel.guildId}`);
                    return;
                }
                
                if (this.claimedChannels.has(channel.id)) {
                    console.log(`[SKIP] Already claimed`);
                    return;
                }
                
                console.log(`[NEW] Setting up #${channel.name}`);
                this.setupChannel(channel);
                
                if (this.isRunning) {
                    const delay = this.randomDelay();
                    console.log(`[CLAIM] Will claim #${channel.name} in ${delay}ms`);
                    setTimeout(() => this.claim(channel), delay);
                } else {
                    console.log(`[PENDING] Not running, will claim when started`);
                }
            });

            this.client.on('channelDelete', channel => {
                if (this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.delete(channel.id);
                    this.saveClaimed();
                    console.log(`[DELETE] Removed ${channel.id}`);
                }
            });
        });

        this.client.on('error', (err) => {
            console.log(`[WS ERROR] ${this.userId}: ${err.message}`);
        });

        this.client.on('disconnect', () => {
            console.log(`[DISCONNECT] ${this.userId}`);
            this.isReady = false;
        });

        // Attempt login
        try {
            await this.client.login(this.config.token);
            console.log(`[SUCCESS] ${this.userId} Login call completed`);
        } catch (err) {
            console.log(`[LOGIN FAIL] ${this.userId}: ${err.message}`);
            this.client = null;
        }
    }

    setupChannel(channel) {
        this.client.on('messageCreate', async (msg) => {
            if (msg.channelId !== channel.id) return;
            if (msg.author.id !== this.client.user.id) {
                // Detect others claiming
                if (msg.content === this.config.claim_cmd && !this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.add(channel.id);
                    this.saveClaimed();
                    console.log(`[DETECTED] ${msg.author.tag} claimed #${channel.name}`);
                }
                return;
            }

            // Handle commands
            if (msg.content === '.stop') {
                if (!this.isRunning) {
                    setTimeout(() => msg.channel.send('⏹️ Already stopped').catch(() => {}), 3000);
                    return;
                }
                this.isRunning = false;
                this.saveStatus();
                console.log(`[CMD] .stop by ${this.userId} in #${channel.name}`);
                setTimeout(() => msg.channel.send('⏹️ Stopped').catch(() => {}), 3000);
                return;
            }

            if (msg.content === '.start') {
                if (this.isRunning) {
                    setTimeout(() => msg.channel.send('▶️ Already running').catch(() => {}), 3000);
                    return;
                }
                this.isRunning = true;
                this.saveStatus();
                console.log(`[CMD] .start by ${this.userId} in #${channel.name}`);
                setTimeout(() => msg.channel.send('▶️ Started').catch(() => {}), 3000);
                
                if (!this.claimedChannels.has(channel.id)) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
                return;
            }

            if (!this.isRunning) return;

            // Auto-claim check for existing channels
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
        });
    }

    async claim(channel) {
        if (!this.isRunning || this.claimedChannels.has(channel.id)) {
            console.log(`[SKIP] ${channel.name} - not running or claimed`);
            return;
        }
        
        this.claimedChannels.add(channel.id);
        this.saveClaimed();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[SUCCESS] ${this.userId} claimed #${channel.name}`);
        } catch (err) {
            console.log(`[FAIL] ${channel.name}: ${err.message}`);
        }
    }

    destroy() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.isReady = false;
    }

    updateFromDB() {
        const user = db.prepare('SELECT status FROM users WHERE user_id = ?').get(this.userId);
        if (!user) return false;
        
        const shouldRun = user.status === 'running';
        if (shouldRun !== this.isRunning) {
            this.isRunning = shouldRun;
            console.log(`[SYNC] ${this.userId} -> ${shouldRun ? 'running' : 'stopped'}`);
            return true;
        }
        return false;
    }
}

bot.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    if (interaction.commandName === 'generatekey') {
        if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: '❌ Owner only', ephemeral: true });
        const key = 'SB-' + require('crypto').randomBytes(8).toString('hex').toUpperCase();
        db.prepare('INSERT INTO keys (key, created_at) VALUES (?, ?)').run(key, Date.now());
        await interaction.reply({ content: `🔑 \`${key}\``, ephemeral: true });
    }

    if (interaction.commandName === 'redeemkey') {
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
        if (!keyData) return interaction.reply({ content: '❌ Invalid key', ephemeral: true });
        if (keyData.redeemed_by) return interaction.reply({ content: '❌ Already redeemed', ephemeral: true });
        db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
        db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(interaction.user.id);
        await interaction.reply({ content: '✅ Redeemed! Use `/manage`', ephemeral: true });
    }

    if (interaction.commandName === 'sales') {
        const total = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
        const redeemed = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Sales Dashboard')
            .setDescription(`Total keys: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**`)
            .setColor(0x5865F2);
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token, status, guild_ids FROM users WHERE token IS NOT NULL').all();
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
        if (!user) return interaction.reply({ content: '❌ Redeem a key first', ephemeral: true });
        
        const sb = activeSelfbots.get(interaction.user.id);
        const isActuallyRunning = sb ? sb.isRunning && sb.isReady : false;
        
        const claimed = JSON.parse(user.claimed_tickets || '[]').length;
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control')
            .addFields(
                { name: 'DB Status', value: user.status, inline: true },
                { name: 'Live Status', value: isActuallyRunning ? 'connected' : 'offline', inline: true },
                { name: 'Claimed', value: `${claimed}`, inline: true },
                { name: 'Guilds', value: user.guild_ids || 'Not set', inline: false },
                { name: 'Categories', value: user.category_ids || 'All', inline: false }
            )
            .setColor(isActuallyRunning ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('🔑 Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('🏠 Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('📁 Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('⌨️ Cmd').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start_btn')
                .setLabel('▶️ Start')
                .setStyle(ButtonStyle.Success)
                .setDisabled(isActuallyRunning),
            new ButtonBuilder()
                .setCustomId('stop_btn')
                .setLabel('⏹️ Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!isActuallyRunning),
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
                console.log(`[BUTTON] Starting ${userId}`);
                sb = new UserSelfbot(userId, user);
                activeSelfbots.set(userId, sb);
                await sb.start();
            } else {
                sb.isRunning = true;
                sb.saveStatus();
            }
            
            await interaction.update({ content: '▶️ Started! Check logs.', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'stop_btn') {
            const sb = activeSelfbots.get(userId);
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            
            if (sb) {
                sb.isRunning = false;
                sb.saveStatus();
            }
            
            await interaction.update({ content: '⏹️ Stopped', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'reset') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', userId);
            const sb = activeSelfbots.get(userId);
            if (sb) sb.claimedChannels.clear();
            await interaction.reply({ content: '✅ Reset', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Config');
        const input = new TextInputBuilder().setCustomId('value').setLabel('Value').setStyle(TextInputStyle.Short).setRequired(true);
        
        if (interaction.customId === 'set_token') input.setLabel('Discord Token');
        if (interaction.customId === 'set_guilds') input.setLabel('Guild IDs (comma)');
        if (interaction.customId === 'set_categories') input.setLabel('Category IDs (comma)');
        if (interaction.customId === 'set_cmd') input.setLabel('Claim Command');

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '');
        const map = { token: 'token', guilds: 'guild_ids', categories: 'category_ids', cmd: 'claim_cmd' };
        if (map[field]) db.prepare(`UPDATE users SET ${map[field]} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        await interaction.reply({ content: `✅ Saved`, ephemeral: true });
    }
});

// Sync loop
setInterval(() => {
    activeSelfbots.forEach((sb, userId) => {
        sb.updateFromDB();
    });
}, 3000);

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag} ready`);
    
    bot.application.commands.set([
        { name: 'generatekey', description: 'Generate key (Owner)' },
        { name: 'redeemkey', description: 'Redeem key', options: [{ name: 'key', type: 3, description: 'Key', required: true }] },
        { name: 'sales', description: 'View stats' },
        { name: 'manage', description: 'Control panel' }
    ]);

    // Restore running instances
    const running = db.prepare("SELECT * FROM users WHERE status = 'running'").all();
    console.log(`[RESTORE] ${running.length} instances to start`);
    
    running.forEach(u => {
        console.log(`[RESTORE] Starting ${u.user_id}`);
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
