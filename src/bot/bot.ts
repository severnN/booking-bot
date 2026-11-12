import type { Config } from '../config.ts';
import { humanDateTime, localDate } from '../domain/time.ts';
import { AppError, STATUS_LABEL, type BookingEvent, type BookingService, type BookingView } from '../services/booking.ts';
import type { UserService } from '../services/users.ts';
import { esc, TelegramApi, TelegramError } from './api.ts';

type Btn = { text: string; callback_data?: string; web_app?: { url: string } };

/**
 * Бот — тонкий слой: открывает приложение, присылает уведомления и даёт админу
 * кнопки быстрых действий. Вся логика записи — в BookingService.
 */
export class Bot {
  api: TelegramApi;
  cfg: Config;
  bookings: BookingService;
  users: UserService;
  private offset = 0;
  private stopped = false;
  private abort: AbortController | null = null;

  constructor(api: TelegramApi, cfg: Config, bookings: BookingService, users: UserService) {
    this.api = api;
    this.cfg = cfg;
    this.bookings = bookings;
    this.users = users;
    bookings.on((e) => this.onBookingEvent(e));
  }

  private get canOpenWebApp(): boolean {
    return this.cfg.webAppUrl.startsWith('https://');
  }

  private webAppButton(text = '🗓 Записаться', path = ''): Btn[] {
    return this.canOpenWebApp ? [{ text, web_app: { url: this.cfg.webAppUrl + path } }] : [];
  }

  private fmt(b: BookingView): string {
    const lines = [
      `<b>${esc(b.service.name)}</b>`,
      `🕒 ${esc(humanDateTime(new Date(b.start), this.cfg.timeZone))}`,
      b.car ? `🚗 ${esc(b.car)}` : '',
      b.comment ? `💬 ${esc(b.comment)}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  private fmtAdmin(b: BookingView): string {
    return [
      this.fmt(b),
      `👤 ${esc(b.client.name || '—')} ${esc(b.client.phone)}`,
      `📍 ${esc(b.postName)} · запись #${b.id}`,
      `Статус: ${STATUS_LABEL[b.status]}`,
    ].join('\n');
  }

  // ---------- отправка с обработкой «пользователь заблокировал бота» ----------

  private async safeSend(chatId: number | string, text: string, buttons?: Btn[][]): Promise<boolean> {
    try {
      await this.api.sendMessage(chatId, text, buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {});
      return true;
    } catch (e) {
      if (e instanceof TelegramError && (e.code === 403 || e.code === 400)) {
        console.warn(`[bot] не удалось написать ${chatId}: ${e.message}`);
        return false;
      }
      throw e;
    }
  }

  private async toAdmins(text: string, buttons?: Btn[][]): Promise<void> {
    if (this.cfg.adminChatId) {
      await this.safeSend(this.cfg.adminChatId, text, buttons);
    } else {
      for (const id of this.cfg.adminIds) await this.safeSend(id, text, buttons);
    }
  }

  private async toClient(b: BookingView, text: string, buttons?: Btn[][]): Promise<void> {
    if (b.client.tgId) await this.safeSend(b.client.tgId, text, buttons);
  }

  // ---------- события записей ----------

  async onBookingEvent(e: BookingEvent): Promise<void> {
    const b = e.booking;
    const adminButtons: Btn[][] = [[{ text: '✅ Подтвердить', callback_data: `ok:${b.id}` }, { text: '❌ Отклонить', callback_data: `no:${b.id}` }]];
    switch (e.type) {
      case 'created':
        if (b.source === 'admin') {
          await this.toClient(b, `Вы записаны ✅\n\n${this.fmt(b)}`);
          return;
        }
        await this.toAdmins(`🆕 <b>Новая запись</b>\n\n${this.fmtAdmin(b)}`, adminButtons);
        await this.toClient(b, `Заявка принята! Мы подтвердим запись в ближайшее время.\n\n${this.fmt(b)}`);
        return;
      case 'rescheduled':
        await this.toAdmins(
          `🔁 <b>Перенос записи</b>\nБыло: ${esc(humanDateTime(new Date(e.previousStart), this.cfg.timeZone))}\n\n${this.fmtAdmin(b)}`,
          adminButtons,
        );
        await this.toClient(b, `Запись перенесена, ждём подтверждения сервиса.\n\n${this.fmt(b)}`);
        return;
      case 'cancelled_by_client':
        await this.toAdmins(`🚫 <b>Клиент отменил запись</b>\n\n${this.fmtAdmin(b)}`);
        return;
      case 'client_confirmed':
        await this.toAdmins(`👍 Клиент подтвердил визит: #${b.id}, ${esc(humanDateTime(new Date(b.start), this.cfg.timeZone))}`);
        return;
      case 'status_changed': {
        const msg: Partial<Record<BookingView['status'], string>> = {
          confirmed: `Запись подтверждена ✅\n\n${this.fmt(b)}${this.cfg.serviceAddress ? `\n📍 ${esc(this.cfg.serviceAddress)}` : ''}`,
          cancelled: `К сожалению, запись отменена сервисом.\n\n${this.fmt(b)}\n\nВыберите другое время — или позвоните нам${this.cfg.servicePhone ? `: ${esc(this.cfg.servicePhone)}` : ''}.`,
          in_progress: `🔧 Машина в работе: ${esc(b.service.name)}`,
          ready: `🎉 <b>Машина готова!</b> Можно забирать.\n\n${this.fmt(b)}`,
          done: `Спасибо, что выбрали нас! Будем рады видеть снова.`,
        };
        const text = msg[b.status];
        if (text) await this.toClient(b, text, b.status === 'cancelled' ? [this.webAppButton('🗓 Выбрать другое время')].filter((r) => r.length) : undefined);
        return;
      }
    }
  }

  // ---------- напоминания ----------

  async sendReminders(): Promise<number> {
    let sent = 0;
    for (const kind of ['24h', '2h'] as const) {
      // claimReminders сразу помечает записи — даже если доставка не удастся (бот заблокирован), повторно не шлём.
      for (const b of await this.bookings.claimReminders(kind)) {
        const head = kind === '24h' ? '⏰ Напоминаем о записи на завтра' : '⏰ Через 2 часа ждём вас';
        const buttons: Btn[][] = b.clientConfirmed
          ? []
          : [[{ text: '👍 Буду', callback_data: `cc:${b.id}` }, { text: '🚫 Отменить', callback_data: `x:${b.id}` }]];
        const reschedule = this.webAppButton('🔁 Перенести', '#/bookings');
        if (reschedule.length) buttons.push(reschedule);
        await this.toClient(b, `${head}\n\n${this.fmt(b)}${this.cfg.serviceAddress ? `\n📍 ${esc(this.cfg.serviceAddress)}` : ''}`, buttons);
        sent++;
      }
    }
    return sent;
  }

  // ---------- входящие ----------

  async setup(): Promise<void> {
    await this.api.call('setMyCommands', {
      commands: [
        { command: 'start', description: 'Записаться в сервис' },
        { command: 'my', description: 'Мои записи' },
        { command: 'contacts', description: 'Адрес и телефон' },
      ],
    });
    if (this.canOpenWebApp) {
      await this.api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Записаться', web_app: { url: this.cfg.webAppUrl } } });
    }
  }

  /** Режим вебхука: Telegram сам присылает апдейты на {WEBAPP_URL}/telegram/webhook. */
  async setWebhook(): Promise<void> {
    const url = new URL('/telegram/webhook', this.cfg.webAppUrl).toString();
    await this.api.call('setWebhook', {
      url,
      secret_token: this.cfg.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 40,
    });
    console.log(`[bot] webhook: ${url}`);
  }

  async handleUpdate(u: any): Promise<void> {
    if (u.message) return this.handleMessage(u.message);
    if (u.callback_query) return this.handleCallback(u.callback_query);
  }

  private async handleMessage(m: any): Promise<void> {
    if (m.chat?.type !== 'private' || !m.from) return;
    const user = await this.users.upsertTelegram(m.from);
    const chatId = m.chat.id;

    if (m.contact) {
      if (m.contact.user_id !== m.from.id) {
        await this.api.sendMessage(chatId, 'Пожалуйста, отправьте свой номер кнопкой ниже.');
        return;
      }
      await this.users.setPhone(user.id, m.contact.phone_number);
      await this.api.sendMessage(chatId, 'Спасибо, номер сохранён 👍', { reply_markup: { remove_keyboard: true } });
      await this.sendMenu(chatId);
      return;
    }

    const text: string = m.text ?? '';
    const cmd = text.split(/[\s@]/)[0];
    if (cmd === '/start') {
      await this.api.sendMessage(chatId, `Здравствуйте! Это бот записи в <b>${esc(this.cfg.serviceName)}</b>.\n\nВыберите услугу и удобное время — подтвердим запись и напомним о визите.`);
      if (!user.phone) {
        await this.api.sendMessage(chatId, 'Чтобы мастер мог связаться с вами, поделитесь номером телефона:', {
          reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
        });
      }
      await this.sendMenu(chatId);
      return;
    }
    if (cmd === '/my') return this.sendMyBookings(chatId, user.id);
    if (cmd === '/contacts') {
      const parts = [`<b>${esc(this.cfg.serviceName)}</b>`, this.cfg.serviceAddress && `📍 ${esc(this.cfg.serviceAddress)}`, this.cfg.servicePhone && `📞 ${esc(this.cfg.servicePhone)}`];
      await this.api.sendMessage(chatId, parts.filter(Boolean).join('\n'));
      return;
    }
    if (cmd === '/today' && this.cfg.adminIds.includes(m.from.id)) return this.sendToday(chatId);
    await this.sendMenu(chatId);
  }

  private async sendMenu(chatId: number): Promise<void> {
    const row = this.webAppButton();
    await this.api.sendMessage(
      chatId,
      row.length ? 'Нажмите кнопку, чтобы записаться или посмотреть свои записи:' : 'Веб-приложение пока не настроено (WEBAPP_URL). Ваши записи: /my',
      row.length ? { reply_markup: { inline_keyboard: [row, [{ text: '📋 Мои записи', callback_data: 'my' }]] } } : {},
    );
  }

  private async sendMyBookings(chatId: number, userId: number): Promise<void> {
    const active = (await this.bookings.listForUser(userId)).filter((b) => ['pending', 'confirmed', 'in_progress', 'ready'].includes(b.status));
    if (active.length === 0) {
      await this.api.sendMessage(chatId, 'Активных записей нет.', this.canOpenWebApp ? { reply_markup: { inline_keyboard: [this.webAppButton()] } } : {});
      return;
    }
    for (const b of active) {
      const buttons: Btn[][] = ['pending', 'confirmed'].includes(b.status) ? [[{ text: '🚫 Отменить', callback_data: `x:${b.id}` }]] : [];
      await this.safeSend(chatId, `${this.fmt(b)}\nСтатус: ${STATUS_LABEL[b.status]}`, buttons);
    }
  }

  private async sendToday(chatId: number): Promise<void> {
    const date = localDate(new Date(), this.cfg.timeZone);
    const { bookings } = await this.bookings.schedule(date);
    const list = bookings.filter((b) => b.status !== 'cancelled');
    if (list.length === 0) {
      await this.api.sendMessage(chatId, 'На сегодня записей нет.');
      return;
    }
    const lines = list.map((b) => {
      const t = new Intl.DateTimeFormat('ru-RU', { timeZone: this.cfg.timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(b.start));
      return `${t} · ${esc(b.postName)} · ${esc(b.service.name)} · ${esc(b.car || '—')} · ${STATUS_LABEL[b.status]}`;
    });
    await this.api.sendMessage(chatId, `<b>Сегодня, ${date}</b>\n\n${lines.join('\n')}`);
  }

  private async handleCallback(q: any): Promise<void> {
    const data: string = q.data ?? '';
    const [action, idStr] = data.split(':');
    const id = Number(idStr);
    const fromId: number = q.from.id;
    const isAdmin = this.cfg.adminIds.includes(fromId);
    let answer = '';
    try {
      if (action === 'my') {
        const user = await this.users.upsertTelegram(q.from);
        await this.sendMyBookings(q.message.chat.id, user.id);
      } else if (action === 'ok' || action === 'no' || action === 'rdy') {
        if (!isAdmin) throw new AppError(403, 'forbidden', 'Только для администратора');
        const status = action === 'ok' ? 'confirmed' : action === 'no' ? 'cancelled' : 'ready';
        const b = await this.bookings.setStatus(id, status);
        answer = STATUS_LABEL[b.status];
        // Обновляем сообщение в админ-чате: убираем кнопки, дописываем кто и что сделал.
        const who = esc([q.from.first_name, q.from.last_name].filter(Boolean).join(' '));
        await this.api
          .call('editMessageText', {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            text: `${this.fmtAdmin(b)}\n\n<i>${who}: ${STATUS_LABEL[b.status]}</i>`,
            parse_mode: 'HTML',
            reply_markup: status === 'confirmed' ? { inline_keyboard: [[{ text: '🎉 Машина готова', callback_data: `rdy:${b.id}` }]] } : undefined,
          })
          .catch(() => {});
      } else if (action === 'cc' || action === 'x') {
        const user = await this.users.byTgId(fromId);
        if (!user) throw new AppError(404, 'user_not_found', 'Сначала нажмите /start');
        if (action === 'cc') {
          await this.bookings.confirmByClient(id, user.id);
          answer = 'Спасибо, ждём вас!';
        } else {
          await this.bookings.cancelByClient(id, user.id);
          answer = 'Запись отменена';
        }
        await this.api.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
        await this.safeSend(q.message.chat.id, answer);
      }
    } catch (e) {
      answer = e instanceof AppError ? e.message : 'Ошибка, попробуйте позже';
      if (!(e instanceof AppError)) console.error('[bot callback]', e);
    }
    await this.api.call('answerCallbackQuery', { callback_query_id: q.id, text: answer.slice(0, 190) }).catch(() => {});
  }

  // ---------- long polling ----------

  /** Режим long polling — для разработки. Работает только в одной копии приложения. */
  async startPolling(): Promise<void> {
    await this.setup().catch((e) => console.error('[bot] setup:', e.message));
    // getUpdates не работает, пока установлен вебхук.
    await this.api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    console.log('[bot] polling started');
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const updates = await this.api.call<any[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          this.abort.signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((e) => console.error('[bot] update', u.update_id, e));
        }
      } catch (e: any) {
        if (this.stopped) break;
        console.error('[bot] polling error:', e?.message ?? e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }
}
