const { Client, GatewayIntentBits, SlashCommandBuilder, Events } = require('discord.js');
const cfg = require('./config');
const db = require('./db');
const { E, level } = require('./util');
const commands = require('./commands');
const dashboard = require('./dashboard');

for (const k of ['TOKEN', 'CLIENT_ID', 'GUILD_ID']) if (!cfg[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(cfg.GUILD_ID);
  await guild.roles.fetch();
  await guild.commands.set([new SlashCommandBuilder().setName('verify').setDescription('Link your Roblox account')
    .addStringOption(o => o.setName('username').setDescription('Your Roblox username').setRequired(true)).toJSON()]);
  dashboard.start(client);
  setInterval(() => db.backupNow().catch(e => console.error('backup failed', e.message)), 6 * 3600e3);
  db.backupNow().catch(() => {});
});

client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot || !msg.guild || msg.guild.id !== cfg.GUILD_ID || !msg.content.startsWith(cfg.PREFIX)) return;
  const [name, ...args] = msg.content.slice(cfg.PREFIX.length).trim().split(/\s+/);
  const cmd = commands.cmds[(name || '').toLowerCase()];
  if (!cmd) return;
  const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
  const ctx = {
    client, guild: msg.guild, user: msg.author, member, args,
    reply: p => msg.reply({ ...p, allowedMentions: { parse: [], repliedUser: false } }),
    send: p => msg.channel.send({ ...p, allowedMentions: { parse: [] } }),
  };
  // Permission gate runs BEFORE any command code, regardless of arguments.
  if (level(member) < cmd.level) return ctx.reply({ embeds: [E('Permission denied', 'You do not have permission to use this command.')] });
  try { msg.channel.sendTyping().catch(() => {}); await cmd.run(ctx); }
  catch (e) { console.error(e); ctx.reply({ embeds: [E('Error', 'Something went wrong. The error was logged.')] }).catch(() => {}); }
});

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'verify') {
      return commands.startVerify({ user: i.user, member: i.member, guild: i.guild, reply: p => i.reply({ ...p, ephemeral: true }) }, i.options.getString('username'));
    }
    if (i.isButton()) {
      if (i.customId === 'verify_confirm') return commands.confirmVerify(i);
      if (i.customId.startsWith('unlink_confirm:')) return commands.confirmUnlink(i);
      if (i.customId.startsWith('rmtier:')) return commands.confirmRemoveTier(i);
    }
  } catch (e) {
    console.error(e);
    const p = { content: 'Something went wrong. The error was logged.', ephemeral: true };
    (i.deferred || i.replied ? i.followUp(p) : i.reply(p)).catch(() => {});
  }
});

process.on('unhandledRejection', e => console.error('unhandled', e));
client.login(cfg.TOKEN);
