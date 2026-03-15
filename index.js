const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = '1422945082746601594';
const API_PORT = process.env.PORT || 3000;

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, claim_cmd TEXT DEFAULT '.claim', guild_id TEXT, category_id TEXT, status TEXT DEFAULT 'stopped');
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const activeSelfbots = new Map();

class UserSelfbot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.claimedChannels = new Set();
        this.isRunning = false;
    }

    randomDelay() {
        return Math.floor(Math.random() * 100) + 200;
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
                    .forEach(ch => this.monitorChannel(ch));
            }

            this.client.on('channelCreate', channel => {
                if (channel.guildId !== this.config.guild_id) return;
                if (channel.type !== 'GUILD_TEXT') return;
                if (this.config.category_id && channel.parentId !== this.config.category_id) return;
                
                this.monitorChannel(channel);
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
            });

            this.client.on('channelDelete', channel => {
                this.claimedChannels.delete(channel.id);
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
        if (!this.isRunning || this.claimedChannels.has(channel.id)) return;
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIM] ${this.userId} claimed #${channel.name}`);
            this.claimedChannels.add(channel.id);

            const collector = channel.createMessageCollector({
                filter: m => m.author.id === this.client.user.id || m.content.includes('unclaim'),
                time: 300000
            });

            collector.on('collect', m => {
                if (m.content.includes('unclaim')) {
                    this.claimedChannels.delete(channel.id);
                    setTimeout(() => this.sendClaim(channel), this.randomDelay());
                    collector.stop();
                }
            });
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
                setTimeout(() => this.sendClaim(channel), this.randomDelay());
                return;
            }

            if (!this.claimedChannels.has(channel.id) && !message.author.bot) {
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

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guild').setLabel('Guild ID').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_category').setLabel('Category').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('Claim Cmd').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('toggle').setLabel(user.status === 'running' ? 'Stop' : 'Start').setStyle(user.status === 'running' ? ButtonStyle.Danger : ButtonStyle.Success)
        );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'toggle') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            const isRunning = user.status === 'running';
            
            if (isRunning) {
                const sb = activeSelfbots.get(interaction.user.id);
                if (sb) sb.stop();
                activeSelfbots.delete(interaction.user.id);
            } else {
                const newSb = new UserSelfbot(interaction.user.id, user);
                activeSelfbots.set(interaction.user.id, newSb);
                newSb.start();
            }
            
            await interaction.update({ content: isRunning ? '⏹️ Stopped' : '▶️ Started', embeds: [], components: [] });
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
        if (interaction.customId === 'set_cmd') input.setLabel('Claim Command (default: .claim)');

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
        const value = interaction.fields.getTextInputValue('value');
        const field = interaction.customId.replace('modal_set_', '');
        
        const column = field === 'cmd' ? 'claim_cmd' : field === 'token' ? 'token' : field === 'guild' ? 'guild_id' : 'category_id';
        db.prepare(`UPDATE users SET ${column} = ? WHERE user_id = ?`).run(value, interaction.user.id);
        
        await interaction.reply({ content: `✅ ${column} updated`, ephemeral: true });
    }
});

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        { name: 'generatekey', description: 'Generate key (Owner only)' },
        { name: 'redeemkey', description: 'Redeem a key', options: [{ name: 'key', type: 3, description: 'Key', required: true }] },
        { name: 'manage', description: 'Manage your selfbot' }
    ]);

    // Restore running selfbots on restart
    const running = db.prepare("SELECT * FROM users WHERE status = 'running'").all();
    running.forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
