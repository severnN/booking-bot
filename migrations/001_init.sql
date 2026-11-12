-- Базовая схема: клиенты, гараж, посты, услуги, записи.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id          serial PRIMARY KEY,
  tg_id       bigint UNIQUE,                       -- NULL для клиентов, записанных вручную по телефону
  name        text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  consent_at  timestamptz,                         -- согласие на обработку ПДн
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_phone ON users (phone) WHERE phone <> '';

CREATE TABLE cars (
  id        serial PRIMARY KEY,
  user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make      text NOT NULL,
  model     text NOT NULL DEFAULT '',
  year      integer,
  plate     text NOT NULL DEFAULT '',
  vin       text NOT NULL DEFAULT '',
  archived  boolean NOT NULL DEFAULT false
);
CREATE INDEX cars_user ON cars (user_id) WHERE NOT archived;

-- Пост = подъёмник / бокс / место шиномонтажа. Ресурс, который занимает запись.
CREATE TABLE posts (
  id      serial PRIMARY KEY,
  name    text NOT NULL,
  kind    text NOT NULL,                           -- lift | tire | ...
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE services (
  id            serial PRIMARY KEY,
  category      text NOT NULL,
  name          text NOT NULL,
  duration_min  integer NOT NULL CHECK (duration_min > 0),
  price_from    integer NOT NULL DEFAULT 0,        -- в рублях
  post_kind     text NOT NULL,
  sort          integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE closed_dates (
  date    date PRIMARY KEY,                        -- местная дата сервиса
  reason  text NOT NULL DEFAULT ''
);

CREATE TABLE bookings (
  id                serial PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users(id),
  car_id            integer REFERENCES cars(id),
  car_text          text NOT NULL DEFAULT '',      -- для ручных записей без «гаража»
  service_id        integer NOT NULL REFERENCES services(id),
  post_id           integer NOT NULL REFERENCES posts(id),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending','confirmed','in_progress','ready','done','cancelled','no_show')),
  comment           text NOT NULL DEFAULT '',
  source            text NOT NULL DEFAULT 'app',   -- app | admin
  reminded_24h      boolean NOT NULL DEFAULT false,
  reminded_2h       boolean NOT NULL DEFAULT false,
  client_confirmed  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- Главная гарантия от двойной брони: на одном посту активные записи не пересекаются по времени.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    post_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  ) WHERE (status IN ('pending','confirmed','in_progress','ready'))
);
CREATE INDEX bookings_user ON bookings (user_id, start_at);
CREATE INDEX bookings_start ON bookings (start_at);
