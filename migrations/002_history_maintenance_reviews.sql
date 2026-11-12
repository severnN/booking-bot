-- История обслуживания, напоминания о плановом ТО, отзывы.

-- Какие услуги считаются плановым ТО (от них считается следующее).
ALTER TABLE services ADD COLUMN is_maintenance boolean NOT NULL DEFAULT false;
UPDATE services SET is_maintenance = true WHERE category = 'ТО';

-- Итог визита: пробег, что сделано, когда выдали машину.
ALTER TABLE bookings
  ADD COLUMN mileage_km integer CHECK (mileage_km >= 0),
  ADD COLUMN work_notes text NOT NULL DEFAULT '',
  ADD COLUMN done_at timestamptz;
CREATE INDEX bookings_car_done ON bookings (car_id, start_at) WHERE status = 'done';

-- По какой записи ТО уже отправлено напоминание (чтобы не повторять).
ALTER TABLE cars ADD COLUMN maint_reminded_booking_id integer REFERENCES bookings(id) ON DELETE SET NULL;

CREATE TABLE reviews (
  booking_id  integer PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_created ON reviews (created_at DESC);
