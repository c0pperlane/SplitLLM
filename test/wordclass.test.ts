import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDb } from '../src/graph/db.ts';
import { anySubject, judgeWord } from '../src/learn/wordclass.ts';

function dbWithPages(): GraphDb {
  const db = new GraphDb(':memory:');
  db.upsertModule({ name: 'nginx', description: 'web server and reverse proxy' });
  db.putCachedPage('https://a.example/sourdough', 'a.example', 200,
    `<html><head><title>Sourdough bread for beginners</title></head><body><h1>Sourdough bread</h1><p>Flour, wasser, salt and time make the dough rise.</p></body></html>`);
  db.putCachedPage('https://b.example/nginx', 'b.example', 200,
    `<html><head><title>How to install nginx</title></head><body><h1>Install nginx</h1><p>apt install nginx — the web server. You can make it work with wasser.</p></body></html>`);
  db.putCachedPage('https://c.example/teig', 'c.example', 200,
    `<html><head><title>Der Teig</title></head><body><h1>Teig kneten</h1><p>Wie man eine gute Krume bekommt und was der Teig mit wasser macht.</p></body></html>`);
  return db;
}

test('topics in titles are subjects', async () => {
  const db = dbWithPages();
  assert.equal((await judgeWord(db, 'sourdough')).cls, 'subject');
  assert.equal((await judgeWord(db, 'nginx')).cls, 'subject');
});

test('a corpus-unknown word is a subject — unless the dictionary calls it basic', async () => {
  const db = dbWithPages();
  // Offline: the unknown-word vote stands, a distinctive unknown is worth learning.
  assert.equal((await judgeWord(db, 'thermonukleare')).cls, 'subject');
  // The dictionary knows it as a verb: the unknown-word vote is blocked.
  const verbFetch = async () => 'verb';
  const v = await judgeWord(db, 'make', verbFetch);
  assert.notEqual(v.cls, 'subject');
});

test('a word spread across bodies but never in a title is glue', async () => {
  const db = dbWithPages();
  // 'wasser' is in all three bodies and zero titles.
  const v = await judgeWord(db, 'wasser');
  assert.equal(v.cls, 'generic');
  assert.equal(v.signals.titleDf, 0);
  assert.ok(v.signals.pageDf >= 3);
});

test('anySubject blocks basic-word queries, allows subject queries', async () => {
  const db = dbWithPages();
  assert.equal((await anySubject(db, ['sourdough'])).yes, true);
  assert.equal((await anySubject(db, ['thermonukleare'])).yes, true);
  const verbOnly = async () => 'verb';
  assert.equal((await anySubject(db, ['make'], verbOnly)).yes, false);
});

test('the dictionary cache remembers', async () => {
  const db = dbWithPages();
  db.setWordPos('bread', 'noun');
  assert.equal(db.getWordPos('bread'), 'noun');
  assert.equal(db.getWordPos('never-asked'), undefined);
});
