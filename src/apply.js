// language: JavaScript, file: apply.js — restocker apply panel + modal
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const perms = require('./permissions');
const logs = require('./logs');
const config = require('./config');

// 5 questions max for Discord modal (one short + four paragraphs)
const QUESTIONS = [
  {
    id: 'why',
    label: 'Why restocker?',
    placeholder: 'Why do you want to restock for this farm?',
    style: TextInputStyle.Paragraph,
    required: true,
    max: 500,
  },
  {
    id: 'volume',
    label: 'Weekly OAuth volume',
    placeholder: 'How many accounts can you supply per week?',
    style: TextInputStyle.Short,
    required: true,
    max: 100,
  },
  {
    id: 'experience',
    label: 'Past farm experience',
    placeholder: 'Other farms? How long? What was your role?',
    style: TextInputStyle.Paragraph,
    required: true,
    max: 500,
  },
  {
    id: 'quality',
    label: 'Token quality policy',
    placeholder: 'Confirm you understand invalid/phone-locked tokens get removed',
    style: TextInputStyle.Short,
    required: true,
    max: 150,
  },
  {
    id: 'availability',
    label: 'Timezone & availability',
    placeholder: 'e.g. CET, evenings weekdays',
    style: TextInputStyle.Short,
    required: true,
    max: 150,
  },
];

async function ensureTable() {
  await query(`
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_tag TEXT,
  type TEXT DEFAULT 'restocker',
  answers JSONB NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  reviewer_id TEXT,
  review_note TEXT,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
  reviewed_at BIGINT
);
`);
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('Restocker Application')
    .setColor(0x5865f2)
    .setDescription(
      [
        'Want to **restock** OAuth accounts for this farm?',
        '',
        'Click **Apply** below and answer the questions.',
        'Staff will review your application and assign the restocker role if accepted.',
        '',
        '**Requirements**',
        '• Valid Discord account',
        '• Ability to supply clean OAuth tokens',
        '• Understand that bad tokens are removed from stock',
      ].join('\n')
    )
    .setFooter({ text: 'Member Farm · Apply' })
    .setTimestamp();
}

function panelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('apply_open')
      .setLabel('Apply')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildModal() {
  const modal = new ModalBuilder()
    .setCustomId('apply_modal')
    .setTitle('Restocker Application');

  for (const q of QUESTIONS) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(q.label.slice(0, 45))
      .setPlaceholder(q.placeholder.slice(0, 100))
      .setStyle(q.style)
      .setRequired(q.required)
      .setMaxLength(q.max);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function buildReviewEmbed(app) {
  const answers =
    typeof app.answers === 'string' ? JSON.parse(app.answers) : app.answers || {};
  const fields = QUESTIONS.map((q) => ({
    name: q.label,
    value: String(answers[q.id] || '—').slice(0, 1020),
  }));
  return new EmbedBuilder()
    .setTitle(`Restocker Application #${app.id}`)
    .setColor(app.status === 'pending' ? 0xfaa61a : app.status === 'accepted' ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'Applicant', value: `<@${app.user_id}>\n\`${app.user_id}\``, inline: true },
      { name: 'Tag', value: app.user_tag || '—', inline: true },
      { name: 'Status', value: `\`${app.status}\``, inline: true },
      ...fields
    )
    .setFooter({ text: 'Member Farm · Staff Review' })
    .setTimestamp();
}

function reviewButtons(appId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply_accept_${appId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`apply_deny_${appId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );
}

async function postPanel(channel) {
  return channel.send({
    embeds: [buildPanelEmbed()],
    components: [panelButton()],
  });
}

async function acceptApp(appId, reviewer, client) {
  await ensureTable();
  const app = await one(`SELECT * FROM applications WHERE id = $1`, [appId]);
  if (!app) return { ok: false, reason: 'not_found' };
  if (app.status !== 'pending') return { ok: false, reason: 'not_pending', status: app.status };

  await query(
    `UPDATE applications SET status = 'accepted', reviewer_id = $1, reviewed_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $2`,
    [reviewer.id, appId]
  );

  // Role only — no restock permission grant
  const roleId = await getSetting('restocker_role');
  let roleGiven = false;
  if (roleId) {
    try {
      const guild = await client.guilds.fetch(config.MAIN_GUILD_ID).catch(() => null);
      const member = await guild?.members.fetch(app.user_id).catch(() => null);
      if (member) {
        await member.roles.add(roleId);
        roleGiven = true;
      }
    } catch (e) {
      console.error('apply role', e.message);
    }
  }

  try {
    const user = await client.users.fetch(app.user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Accepted')
          .setColor(0x57f287)
          .setDescription(
            `Your restocker application **#${appId}** was **accepted**.` +
              (roleGiven
                ? '\nThe restocker role has been assigned.'
                : '\nStaff will assign your role shortly.')
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
  } catch {}

  logs.adminLog(
    client,
    'Application accepted',
    `**#${appId}** <@${app.user_id}> by <@${reviewer.id}>` +
      (roleGiven ? ' · role given' : ' · **no restocker_role set**')
  );
  return { ok: true, app, roleGiven };
}

async function denyApp(appId, reviewer, client, note) {
  await ensureTable();
  const app = await one(`SELECT * FROM applications WHERE id = $1`, [appId]);
  if (!app) return { ok: false, reason: 'not_found' };
  if (app.status !== 'pending') return { ok: false, reason: 'not_pending', status: app.status };

  await query(
    `UPDATE applications SET status = 'denied', reviewer_id = $1, review_note = $2, reviewed_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $3`,
    [reviewer.id, note || null, appId]
  );

  try {
    const user = await client.users.fetch(app.user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Denied')
          .setColor(0xed4245)
          .setDescription(
            `Your restocker application **#${appId}** was **denied**.` +
              (note ? `\n\nReason: ${note}` : '')
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
  } catch {}

  logs.adminLog(
    client,
    'Application denied',
    `**#${appId}** <@${app.user_id}> by <@${reviewer.id}>` + (note ? ` — ${note}` : '')
  );
  return { ok: true, app };
}

async function handleApplyCommand(message, args, client, permsMod) {
  await ensureTable();
  const sub = (args[0] || '').toLowerCase();

  // Admin posts the permanent panel
  if (sub === 'panel' || sub === 'post') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    await postPanel(message.channel);
    await message.reply('Apply panel posted.').then((m) => setTimeout(() => m.delete().catch(() => {}), 4000));
    return true;
  }

  if (sub === 'channel') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    if (args[1] === 'set') {
      const ch = message.mentions.channels.first();
      if (!ch) {
        await message.reply('Usage: apply channel set #channel');
        return true;
      }
      await setSetting('apply_channel', ch.id);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Apply Review Channel Set')
            .setColor(0x57f287)
            .addFields({ name: 'Channel', value: `${ch}` })
            .setFooter({ text: 'Member Farm' })
            .setTimestamp(),
        ],
      });
      return true;
    }
    const id = await getSetting('apply_channel', 'not set');
    await message.reply(id === 'not set' ? 'No review channel set.' : `Review channel: <#${id}>`);
    return true;
  }

  if (sub === 'role') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    if (args[1] === 'set') {
      const role = message.mentions.roles.first();
      if (!role) {
        await message.reply('Usage: apply role set @role');
        return true;
      }
      await setSetting('restocker_role', role.id);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Restocker Role Set')
            .setColor(0x57f287)
            .addFields({ name: 'Role', value: `${role}` })
            .setDescription('Accepted applicants receive **only this role** (no restock command grant).')
            .setFooter({ text: 'Member Farm' })
            .setTimestamp(),
        ],
      });
      return true;
    }
    const id = await getSetting('restocker_role', 'not set');
    await message.reply(id === 'not set' ? 'No restocker role set.' : `Restocker role: <@&${id}>`);
    return true;
  }

  if (sub === 'list') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const rows = await many(
      `SELECT id, user_id, user_tag, status, created_at FROM applications ORDER BY id DESC LIMIT 15`
    );
    if (!rows.length) {
      await message.reply('No applications yet.');
      return true;
    }
    const lines = rows.map(
      (r) => `**#${r.id}** <@${r.user_id}> · \`${r.status}\` · <t:${r.created_at}:R>`
    );
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Applications')
          .setColor(0x5865f2)
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
    return true;
  }

  if (sub === 'view') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply view <id>');
      return true;
    }
    const app = await one(`SELECT * FROM applications WHERE id = $1`, [id]);
    if (!app) {
      await message.reply('Application not found.');
      return true;
    }
    await message.reply({
      embeds: [buildReviewEmbed(app)],
      components: app.status === 'pending' ? [reviewButtons(app.id)] : [],
    });
    return true;
  }

  if (sub === 'accept') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply accept <id>');
      return true;
    }
    const res = await acceptApp(id, message.author, client);
    if (!res.ok) {
      await message.reply(`Cannot accept: \`${res.reason}\``);
      return true;
    }
    await message.reply(
      `Application **#${id}** accepted.` +
        (res.roleGiven ? ' Role assigned.' : ' *(Set restocker role with `apply role set @role`)*')
    );
    return true;
  }

  if (sub === 'deny') {
    if (!(await permsMod.canUse(message.author.id, 'apply')) && !permsMod.isOwner(message.author.id))
      return true;
    const id = parseInt(args[1], 10);
    if (!id) {
      await message.reply('Usage: apply deny <id> [reason]');
      return true;
    }
    const note = args.slice(2).join(' ') || null;
    const res = await denyApp(id, message.author, client, note);
    if (!res.ok) {
      await message.reply(`Cannot deny: \`${res.reason}\``);
      return true;
    }
    await message.reply(`Application **#${id}** denied.`);
    return true;
  }

  // Default help for staff / users
  await message.reply(
    [
      '**Apply system**',
      'Users: click **Apply** on the panel (staff posts it with `apply panel`).',
      '',
      'Staff:',
      '`apply panel` — post embed + button in this channel',
      '`apply channel set #ch` — review channel for submissions',
      '`apply role set @role` — role given on accept (role only, no restock grant)',
      '`apply list` · `apply view <id>`',
      '`apply accept <id>` · `apply deny <id> [reason]`',
    ].join('\n')
  );
  return true;
}

async function handleApplyButton(interaction, client) {
  // Open modal
  if (interaction.customId === 'apply_open') {
    await ensureTable();
    const open = await one(
      `SELECT id FROM applications WHERE user_id = $1 AND status = 'pending'`,
      [interaction.user.id]
    );
    if (open) {
      await interaction.reply({
        content: `You already have a pending application (**#${open.id}**).`,
        ephemeral: true,
      });
      return true;
    }
    await interaction.showModal(buildModal());
    return true;
  }

  // Accept / Deny
  if (!interaction.customId.startsWith('apply_accept_') && !interaction.customId.startsWith('apply_deny_'))
    return false;

  const isOwner = String(interaction.user.id) === String(config.OWNER_ID);
  const can = isOwner || (await perms.canUse(interaction.user.id, 'apply'));
  if (!can) {
    await interaction.reply({ content: 'No permission.', ephemeral: true });
    return true;
  }

  const appId = parseInt(interaction.customId.split('_').pop(), 10);

  if (interaction.customId.startsWith('apply_accept_')) {
    const res = await acceptApp(appId, interaction.user, client);
    if (!res.ok) {
      await interaction.reply({ content: `Cannot accept: \`${res.reason}\``, ephemeral: true });
      return true;
    }
    const emb = buildReviewEmbed({ ...res.app, status: 'accepted' });
    await interaction.update({
      content: `Accepted by <@${interaction.user.id}>` +
        (res.roleGiven ? ' · role assigned' : ' · set `apply role set @role`'),
      embeds: [emb],
      components: [],
    });
    return true;
  }

  const res = await denyApp(appId, interaction.user, client, 'Denied via button');
  if (!res.ok) {
    await interaction.reply({ content: `Cannot deny: \`${res.reason}\``, ephemeral: true });
    return true;
  }
  const emb = buildReviewEmbed({ ...res.app, status: 'denied' });
  await interaction.update({
    content: `Denied by <@${interaction.user.id}>`,
    embeds: [emb],
    components: [],
  });
  return true;
}

async function handleApplyModal(interaction, client) {
  if (interaction.customId !== 'apply_modal') return false;

  await ensureTable();

  const open = await one(
    `SELECT id FROM applications WHERE user_id = $1 AND status = 'pending'`,
    [interaction.user.id]
  );
  if (open) {
    await interaction.reply({
      content: `You already have a pending application (**#${open.id}**).`,
      ephemeral: true,
    });
    return true;
  }

  const answers = {};
  for (const q of QUESTIONS) {
    answers[q.id] = (interaction.fields.getTextInputValue(q.id) || '').slice(0, q.max);
  }

  const row = await one(
    `INSERT INTO applications (user_id, user_tag, type, answers, status)
     VALUES ($1, $2, 'restocker', $3::jsonb, 'pending')
     RETURNING *`,
    [interaction.user.id, interaction.user.tag, JSON.stringify(answers)]
  );

  const reviewChId = await getSetting('apply_channel');
  if (reviewChId) {
    try {
      const ch = await client.channels.fetch(reviewChId).catch(() => null);
      if (ch) {
        await ch.send({
          content: 'New restocker application',
          embeds: [buildReviewEmbed(row)],
          components: [reviewButtons(row.id)],
        });
      }
    } catch (e) {
      console.error('apply review post', e.message);
    }
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Application Submitted')
        .setColor(0x57f287)
        .setDescription(
          `Your restocker application **#${row.id}** was submitted.\nStaff will review it shortly.`
        )
        .setFooter({ text: 'Member Farm' })
        .setTimestamp(),
    ],
    ephemeral: true,
  });

  logs.adminLog(
    client,
    'New application',
    `<@${interaction.user.id}> submitted restocker application **#${row.id}**`
  );
  return true;
}

// Legacy no-op for message Q&A sessions (panel+modal only now)
async function handleApplyMessage() {
  return false;
}

module.exports = {
  handleApplyCommand,
  handleApplyMessage,
  handleApplyButton,
  handleApplyModal,
  ensureTable,
  postPanel,
};
