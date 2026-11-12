// Веб-клиент: работает и как Telegram Mini App, и как обычное веб-приложение / PWA.
const tg = window.Telegram?.WebApp;
const inTelegram = !!tg?.initData;
if (inTelegram) {
  document.documentElement.classList.add('tg');
  tg.ready();
  tg.expand();
} else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const state = { token: null, me: null, cfg: null, services: [], dates: null };
const STATUS = {
  pending: 'Ожидает подтверждения',
  confirmed: 'Подтверждена',
  in_progress: 'В работе',
  ready: 'Машина готова',
  done: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Не приехал',
};
const ACTIVE = ['pending', 'confirmed', 'in_progress', 'ready'];
const $app = document.getElementById('app');

// ---------- утилиты ----------

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

/** el('div', {class: 'x', onclick}, 'текст', child) — без innerHTML, значит без XSS. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

function haptic(type) {
  try { tg?.HapticFeedback?.notificationOccurred(type); } catch {}
}

function ask(text) {
  if (inTelegram && tg.showConfirm) return new Promise((r) => tg.showConfirm(text, r));
  return Promise.resolve(window.confirm(text));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout();
    throw new Error('Сессия истекла, войдите снова');
  }
  if (!res.ok) throw new Error(data.message || 'Ошибка сервера');
  return data;
}

const tz = () => state.cfg?.timeZone || 'Europe/Moscow';
const fmtTime = (iso) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const fmtDateTime = (iso) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const dateParts = (d) => {
  const dt = new Date(`${d}T12:00:00Z`);
  return {
    wd: new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(dt),
    day: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(dt),
  };
};
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const rub = (n) => `от ${Number(n).toLocaleString('ru-RU')} ₽`;
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`);
const badge = (s) => el('span', { class: `badge ${s}` }, STATUS[s] || s);

function withBusy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(...args); } catch (e) { haptic('error'); toast(e.message); } finally { btn.disabled = false; }
  };
}

// ---------- вход ----------

async function boot() {
  state.cfg = await api('/api/config');
  document.getElementById('brand').textContent = state.cfg.serviceName;
  document.title = state.cfg.serviceName;
  state.services = await api('/api/services');

  if (inTelegram) {
    const r = await api('/api/auth/webapp', { method: 'POST', body: { initData: tg.initData } });
    state.token = r.token;
  } else {
    state.token = store.get('token');
  }
  if (!state.token) return renderLogin();
  try {
    await loadMe();
  } catch {
    return renderLogin();
  }
  document.getElementById('tabs').hidden = false;
  window.addEventListener('hashchange', route);
  route();
}

async function loadMe() {
  state.me = await api('/api/me');
  document.getElementById('tab-admin').hidden = !state.me.isAdmin;
}

function logout() {
  state.token = null;
  state.me = null;
  store.set('token', null);
  document.getElementById('tabs').hidden = true;
  renderLogin();
}

async function finishLogin(r) {
  state.token = r.token;
  store.set('token', r.token);
  await loadMe();
  document.getElementById('tabs').hidden = false;
  window.addEventListener('hashchange', route);
  route();
}

function renderLogin() {
  const box = el('div', { class: 'card' },
    el('h2', {}, 'Вход'),
    el('p', { class: 'muted' }, 'Войдите через Telegram — так мы сможем присылать подтверждения и напоминания о записи.'),
  );
  if (state.cfg.botUsername) {
    window.onTelegramAuth = (user) => api('/api/auth/widget', { method: 'POST', body: user }).then(finishLogin).catch((e) => toast(e.message));
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', state.cfg.botUsername);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    box.append(s);
    box.append(el('p', { class: 'muted' }, 'Или откройте бота ', el('a', { href: `https://t.me/${state.cfg.botUsername}` }, `@${state.cfg.botUsername}`), ' в Telegram.'));
  }
  if (state.cfg.devLogin) {
    const id = el('input', { type: 'number', placeholder: 'Telegram ID', value: '1001' });
    const btn = el('button', { class: 'btn secondary block' }, 'Dev-вход');
    btn.onclick = withBusy(btn, async () => finishLogin(await api('/api/auth/dev', { method: 'POST', body: { tgId: Number(id.value), name: 'Тестовый клиент' } })));
    box.append(el('h3', {}, 'Режим разработки'), id, el('div', { style: 'height:8px' }), btn);
  }
  $app.replaceChildren(box);
}

// ---------- роутинг ----------

function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  const tab = { '/': 'book', '/bookings': 'bookings', '/garage': 'garage', '/admin': 'admin' }[path] || 'book';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const screens = { book: renderBook, bookings: renderBookings, garage: renderGarage, admin: renderAdmin };
  (state.me.isAdmin || tab !== 'admin' ? screens[tab] : renderBook)();
}

// ---------- выбор даты и времени (общий компонент) ----------

async function getDates() {
  if (!state.dates) state.dates = await api('/api/dates');
  return state.dates;
}

/** Даты → слоты. onPick(startIso | null). */
function slotPicker({ serviceId, excludeBooking, onPick }) {
  const root = el('div');
  const datesRow = el('div', { class: 'chips' });
  const slotsBox = el('div');
  root.append(el('h3', {}, 'Дата'), datesRow, el('h3', {}, 'Время'), slotsBox);
  slotsBox.append(el('div', { class: 'muted' }, 'Выберите дату'));
  let selectedDate = null;

  const loadSlots = async (date) => {
    selectedDate = date;
    onPick(null);
    [...datesRow.children].forEach((c) => c.classList.toggle('selected', c.dataset.date === date));
    slotsBox.replaceChildren(el('div', { class: 'muted' }, 'Загружаем свободное время…'));
    const q = new URLSearchParams({ serviceId, date, ...(excludeBooking ? { excludeBooking } : {}) });
    const slots = await api(`/api/slots?${q}`).catch((e) => (toast(e.message), []));
    if (selectedDate !== date) return;
    if (slots.length === 0) {
      slotsBox.replaceChildren(el('div', { class: 'muted' }, 'На этот день свободного времени нет — выберите другой.'));
      return;
    }
    const grid = el('div', { class: 'grid' });
    for (const s of slots) {
      const b = el('button', { class: 'chip', type: 'button' }, s.time);
      b.onclick = () => {
        [...grid.children].forEach((c) => c.classList.remove('selected'));
        b.classList.add('selected');
        onPick(s.start);
      };
      grid.append(b);
    }
    slotsBox.replaceChildren(grid);
  };

  getDates().then((dates) => {
    if (dates.length === 0) datesRow.append(el('div', { class: 'muted' }, 'Нет доступных дат'));
    for (const d of dates) {
      const p = dateParts(d);
      const chip = el('button', { class: 'chip', type: 'button', 'data-date': d }, p.wd, el('small', {}, p.day));
      chip.onclick = () => loadSlots(d);
      datesRow.append(chip);
    }
  });
  return root;
}

// ---------- запись ----------

function renderBook() {
  const f = { serviceId: null, start: null };
  const servicesCard = el('div', { class: 'card' }, el('h2', {}, 'Что нужно сделать?'));
  const pickerCard = el('div', { class: 'card', hidden: true });
  const detailsCard = el('div', { class: 'card', hidden: true });

  const byCat = {};
  for (const s of state.services) (byCat[s.category] ||= []).push(s);
  for (const [cat, items] of Object.entries(byCat)) {
    const list = el('div', { class: 'list' });
    for (const s of items) {
      const opt = el('button', { class: 'option', type: 'button' },
        el('span', {}, s.name, el('div', { class: 'muted' }, dur(s.durationMin))),
        el('span', { class: 'price' }, rub(s.priceFrom)),
      );
      opt.onclick = () => {
        servicesCard.querySelectorAll('.option').forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        f.serviceId = s.id;
        f.start = null;
        detailsCard.hidden = true;
        pickerCard.hidden = false;
        pickerCard.replaceChildren(
          el('h2', {}, 'Когда удобно приехать?'),
          slotPicker({
            serviceId: s.id,
            onPick: (start) => {
              f.start = start;
              detailsCard.hidden = !start;
              if (start) renderDetails();
            },
          }),
        );
        pickerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      list.append(opt);
    }
    servicesCard.append(el('h3', {}, cat), list);
  }

  function renderDetails() {
    const { user, cars } = state.me;
    const svc = state.services.find((s) => s.id === f.serviceId);
    const carSel = el('select', {},
      ...cars.map((c) => el('option', { value: c.id }, c.label)),
      el('option', { value: '' }, '+ Другой автомобиль'),
    );
    const make = el('input', { placeholder: 'Марка, например Kia' });
    const model = el('input', { placeholder: 'Модель, например Rio' });
    const plate = el('input', { placeholder: 'Госномер (необязательно)' });
    const saveCar = el('input', { type: 'checkbox', checked: true });
    const newCar = el('div', {}, el('label', {}, 'Марка'), make, el('label', {}, 'Модель'), model, el('label', {}, 'Госномер'), plate,
      el('label', { class: 'check' }, saveCar, 'Сохранить в гараж'));
    const syncCar = () => (newCar.hidden = carSel.value !== '');
    carSel.onchange = syncCar;
    syncCar();

    const name = el('input', { value: user.name, placeholder: 'Как к вам обращаться' });
    const phone = el('input', { type: 'tel', value: user.phone, placeholder: '+7 900 000-00-00' });
    const comment = el('textarea', { placeholder: 'Что беспокоит? Например: стук спереди справа на кочках' });
    const consent = el('input', { type: 'checkbox' });
    const submit = el('button', { class: 'btn block' }, 'Записаться');

    submit.onclick = withBusy(submit, async () => {
      let carId = carSel.value ? Number(carSel.value) : null;
      let carText = '';
      if (!carId) {
        if (!make.value.trim()) throw new Error('Укажите марку автомобиля');
        if (saveCar.checked) {
          const car = await api('/api/cars', { method: 'POST', body: { make: make.value, model: model.value, plate: plate.value } });
          carId = car.id;
        } else carText = [make.value, model.value, plate.value].filter(Boolean).join(' ');
      }
      const b = await api('/api/bookings', {
        method: 'POST',
        body: { serviceId: f.serviceId, start: f.start, carId, carText, comment: comment.value, name: name.value, phone: phone.value, consent: consent.checked || !!user.consentAt },
      });
      haptic('success');
      await loadMe();
      state.dates = null;
      $app.replaceChildren(el('div', { class: 'card success' },
        el('div', { class: 'icon' }, '✅'),
        el('h2', {}, 'Заявка отправлена'),
        el('p', {}, `${b.service.name}, ${fmtDateTime(b.start)}`),
        el('p', { class: 'muted' }, inTelegram ? 'Подтверждение придёт в чат с ботом.' : 'Мы подтвердим запись — статус виден в «Мои записи».'),
        el('a', { class: 'btn secondary', href: '#/bookings' }, 'Мои записи'),
      ));
    });

    detailsCard.replaceChildren(
      el('h2', {}, 'Детали'),
      el('p', { class: 'muted' }, `${svc.name} · ${fmtDateTime(f.start)}`),
      el('label', {}, 'Автомобиль'), carSel, newCar,
      el('label', {}, 'Имя'), name,
      el('label', {}, 'Телефон'), phone,
      el('label', {}, 'Комментарий для мастера'), comment,
      user.consentAt ? null : el('label', { class: 'check' }, consent, 'Согласен(на) на обработку персональных данных'),
      el('div', { style: 'height:12px' }),
      submit,
    );
    detailsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $app.replaceChildren(servicesCard, pickerCard, detailsCard);
}

// ---------- мои записи ----------

async function renderBookings() {
  $app.replaceChildren(el('div', { class: 'loader' }, 'Загрузка…'));
  const list = await api('/api/bookings');
  if (list.length === 0) {
    $app.replaceChildren(el('div', { class: 'card empty' }, 'Записей пока нет', el('div', { style: 'height:12px' }), el('a', { class: 'btn', href: '#/' }, 'Записаться')));
    return;
  }
  const now = Date.now();
  const cards = list.map((b) => {
    const card = el('div', { class: 'card' },
      el('div', { class: 'row between' }, el('b', {}, b.service.name), badge(b.status)),
      el('div', {}, fmtDateTime(b.start)),
      b.car ? el('div', { class: 'muted' }, b.car) : null,
      b.comment ? el('div', { class: 'muted' }, `«${b.comment}»`) : null,
    );
    if (['pending', 'confirmed'].includes(b.status) && new Date(b.start).getTime() > now) {
      const move = el('button', { class: 'btn secondary small' }, 'Перенести');
      const cancel = el('button', { class: 'btn danger small' }, 'Отменить');
      const area = el('div');
      cancel.onclick = withBusy(cancel, async () => {
        if (!(await ask('Отменить запись?'))) return;
        await api(`/api/bookings/${b.id}/cancel`, { method: 'POST' });
        state.dates = null;
        toast('Запись отменена');
        renderBookings();
      });
      move.onclick = () => {
        let picked = null;
        const save = el('button', { class: 'btn block', disabled: true }, 'Перенести на выбранное время');
        save.onclick = withBusy(save, async () => {
          await api(`/api/bookings/${b.id}/reschedule`, { method: 'POST', body: { start: picked } });
          haptic('success');
          toast('Запись перенесена');
          renderBookings();
        });
        area.replaceChildren(slotPicker({ serviceId: b.service.id, excludeBooking: b.id, onPick: (s) => { picked = s; save.disabled = !s; } }), el('div', { style: 'height:10px' }), save);
      };
      card.append(el('div', { class: 'row', style: 'margin-top:10px; gap:16px' }, move, cancel), area);
    }
    return card;
  });
  const active = list.filter((b) => ACTIVE.includes(b.status));
  const past = list.filter((b) => !ACTIVE.includes(b.status));
  $app.replaceChildren(
    ...(active.length ? [el('h3', {}, 'Предстоящие'), ...cards.slice(0, active.length)] : []),
    ...(past.length ? [el('h3', {}, 'История'), ...cards.slice(active.length)] : []),
  );
}

// ---------- гараж ----------

function renderGarage() {
  const { cars } = state.me;
  const list = el('div', { class: 'list' });
  if (cars.length === 0) list.append(el('div', { class: 'muted', style: 'padding:8px 0' }, 'Пока пусто'));
  for (const c of cars) {
    const del = el('button', { class: 'btn danger small' }, 'Удалить');
    del.onclick = withBusy(del, async () => {
      if (!(await ask(`Удалить ${c.label}?`))) return;
      await api(`/api/cars/${c.id}`, { method: 'DELETE' });
      await loadMe();
      renderGarage();
    });
    list.append(el('div', { class: 'row between', style: 'padding:10px 0' }, el('span', {}, c.label), del));
  }
  const make = el('input', { placeholder: 'Kia' });
  const model = el('input', { placeholder: 'Rio' });
  const year = el('input', { type: 'number', placeholder: '2019' });
  const plate = el('input', { placeholder: 'А123ВС77' });
  const vin = el('input', { placeholder: '17 символов, необязательно' });
  const add = el('button', { class: 'btn block' }, 'Добавить');
  add.onclick = withBusy(add, async () => {
    await api('/api/cars', { method: 'POST', body: { make: make.value, model: model.value, year: year.value, plate: plate.value, vin: vin.value } });
    await loadMe();
    toast('Автомобиль добавлен');
    renderGarage();
  });
  $app.replaceChildren(
    el('div', { class: 'card' }, el('h2', {}, 'Мои автомобили'), list),
    el('div', { class: 'card' }, el('h2', {}, 'Добавить автомобиль'),
      el('label', {}, 'Марка'), make, el('label', {}, 'Модель'), model, el('label', {}, 'Год'), year,
      el('label', {}, 'Госномер'), plate, el('label', {}, 'VIN'), vin, el('div', { style: 'height:12px' }), add),
    inTelegram ? null : el('div', { class: 'card' }, el('button', { class: 'btn secondary block', onclick: logout }, 'Выйти')),
  );
}

// ---------- админка ----------

const ADMIN_ACTIONS = {
  pending: [['confirmed', 'Подтвердить'], ['cancelled', 'Отклонить']],
  confirmed: [['in_progress', 'В работу'], ['no_show', 'Не приехал'], ['cancelled', 'Отменить']],
  in_progress: [['ready', 'Готова']],
  ready: [['done', 'Выдана']],
};

function renderAdmin(date = todayLocal()) {
  const datesRow = el('div', { class: 'chips' });
  for (let i = -1; i < 14; i++) {
    const d = addDays(todayLocal(), i);
    const p = dateParts(d);
    const chip = el('button', { class: `chip${d === date ? ' selected' : ''}`, type: 'button' }, p.wd, el('small', {}, p.day));
    chip.onclick = () => renderAdmin(d);
    datesRow.append(chip);
  }
  const listBox = el('div', {}, el('div', { class: 'loader' }, 'Загрузка…'));
  const newBtn = el('button', { class: 'btn secondary block' }, '+ Записать клиента по телефону');
  const formBox = el('div');
  newBtn.onclick = () => { newBtn.hidden = true; formBox.replaceChildren(adminNewBookingForm(() => renderAdmin(date))); };

  $app.replaceChildren(el('div', { class: 'card' }, el('h2', {}, 'Расписание'), datesRow), newBtn, formBox, el('div', { style: 'height:12px' }), listBox);

  api(`/api/admin/schedule?date=${date}`).then(({ posts, bookings }) => {
    const out = [];
    for (const p of posts) {
      const items = bookings.filter((b) => b.postName === p.name);
      const card = el('div', { class: 'card' }, el('h2', {}, p.name));
      if (items.length === 0) card.append(el('div', { class: 'muted' }, 'Свободно весь день'));
      for (const b of items) {
        const actions = el('div', { class: 'row wrap', style: 'margin-top:8px' });
        for (const [status, label] of ADMIN_ACTIONS[b.status] || []) {
          const btn = el('button', { class: `btn small ${status === 'cancelled' || status === 'no_show' ? 'secondary' : ''}` }, label);
          btn.onclick = withBusy(btn, async () => {
            await api(`/api/admin/bookings/${b.id}/status`, { method: 'POST', body: { status } });
            renderAdmin(date);
          });
          actions.append(btn);
        }
        card.append(el('div', { style: 'padding:10px 0; border-top:1px solid color-mix(in srgb, var(--hint) 15%, transparent)' },
          el('div', { class: 'row between' }, el('b', {}, `${fmtTime(b.start)}–${fmtTime(b.end)} · ${b.service.name}`), badge(b.status)),
          el('div', {}, b.car || '—'),
          el('div', { class: 'muted' }, b.client.name || 'Без имени', ' · ', b.client.phone ? el('a', { href: `tel:${b.client.phone}` }, b.client.phone) : 'нет телефона',
            b.source === 'admin' ? ' · по телефону' : '', b.clientConfirmed ? ' · 👍 подтвердил визит' : ''),
          b.comment ? el('div', { class: 'muted' }, `«${b.comment}»`) : null,
          actions,
        ));
      }
      out.push(card);
    }
    listBox.replaceChildren(...out);
  }).catch((e) => listBox.replaceChildren(el('div', { class: 'card empty' }, e.message)));
}

function adminNewBookingForm(onDone) {
  const box = el('div', { class: 'card' }, el('h2', {}, 'Новая запись'));
  const svc = el('select', {}, el('option', { value: '' }, 'Выберите услугу'), ...state.services.map((s) => el('option', { value: s.id }, `${s.name} (${dur(s.durationMin)})`)));
  const pickerBox = el('div');
  const name = el('input', { placeholder: 'Имя клиента' });
  const phone = el('input', { type: 'tel', placeholder: '+7…' });
  const car = el('input', { placeholder: 'Авто, например Kia Rio А123ВС77' });
  const comment = el('textarea', { placeholder: 'Комментарий' });
  const save = el('button', { class: 'btn block', disabled: true }, 'Записать');
  let start = null;
  svc.onchange = () => {
    start = null;
    save.disabled = true;
    pickerBox.replaceChildren(svc.value ? slotPicker({ serviceId: Number(svc.value), onPick: (s) => { start = s; save.disabled = !s; } }) : '');
  };
  save.onclick = withBusy(save, async () => {
    await api('/api/admin/bookings', { method: 'POST', body: { serviceId: Number(svc.value), start, clientName: name.value, phone: phone.value, carText: car.value, comment: comment.value } });
    state.dates = null;
    toast('Клиент записан');
    onDone();
  });
  box.append(el('label', {}, 'Услуга'), svc, pickerBox, el('label', {}, 'Имя'), name, el('label', {}, 'Телефон'), phone,
    el('label', {}, 'Автомобиль'), car, el('label', {}, 'Комментарий'), comment, el('div', { style: 'height:12px' }), save);
  return box;
}

boot().catch((e) => {
  console.error(e);
  $app.replaceChildren(el('div', { class: 'card empty' }, 'Не удалось загрузить приложение. ', e.message));
});
