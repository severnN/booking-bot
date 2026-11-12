import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { signSession, verifyLoginWidget, verifySession, verifyWebAppInitData } from '../src/auth/telegram.ts';
import { BOT_TOKEN, makeInitData } from './helpers.ts';

const now = 1_800_000_000;

test('initData: верная подпись принимается', () => {
  const u = verifyWebAppInitData(makeInitData({ id: 42, first_name: 'Аня' }, now - 10), BOT_TOKEN, 86400, now);
  assert.equal(u?.id, 42);
  assert.equal(u?.first_name, 'Аня');
});

test('initData: подделка, чужой токен и протухшие данные отклоняются', () => {
  const good = makeInitData({ id: 42 }, now - 10);
  const tampered = good.replace('%22id%22%3A42', '%22id%22%3A43');
  assert.notEqual(tampered, good);
  assert.equal(verifyWebAppInitData(tampered, BOT_TOKEN, 86400, now), null);
  assert.equal(verifyWebAppInitData(makeInitData({ id: 42 }, now - 10, '1:OTHER'), BOT_TOKEN, 86400, now), null);
  assert.equal(verifyWebAppInitData(makeInitData({ id: 42 }, now - 90000), BOT_TOKEN, 86400, now), null);
  assert.equal(verifyWebAppInitData('', BOT_TOKEN), null);
});

test('Login Widget: проверка подписи', () => {
  const data: Record<string, string | number> = { id: 7, first_name: 'Петя', auth_date: now - 5 };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const hash = createHmac('sha256', createHash('sha256').update(BOT_TOKEN).digest()).update(dcs).digest('hex');
  assert.equal(verifyLoginWidget({ ...data, hash }, BOT_TOKEN, 86400, now)?.id, 7);
  assert.equal(verifyLoginWidget({ ...data, id: 8, hash }, BOT_TOKEN, 86400, now), null);
});

test('сессии: подпись, срок действия, подделка', () => {
  const secret = 'x'.repeat(40);
  const t = signSession(5, secret, 3600, now);
  assert.equal(verifySession(t, secret, now + 10), 5);
  assert.equal(verifySession(t, secret, now + 7200), null);
  assert.equal(verifySession(t, 'y'.repeat(40), now), null);
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 1, exp: now + 999 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${s}`, secret, now), null);
  assert.ok(p);
});
