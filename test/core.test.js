'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../lib/core')

const HOUR = core.HOUR_MS
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime() // 11.11.2026 12:00 local
const TTL = 24 * HOUR

/** A minimal in-memory stand-in for Inkdrop's env.localDB. */
function fakeDB({ notes = [], tags = [], books = [] } = {}) {
  const store = {
    notes: new Map(notes.map(n => [n._id, { ...n }])),
    tags: new Map(tags.map(t => [t._id, { ...t }])),
    books: new Map(books.map(b => [b._id, { ...b }]))
  }
  let seq = 0
  const db = {
    store,
    puts: [],
    failPutFor: new Set(),
    notes: {
      createId: () => `note:new${++seq}`,
      async get(id) {
        const n = store.notes.get(id)
        if (!n) throw new Error(`missing ${id}`)
        return { ...n, tags: n.tags ? [...n.tags] : undefined }
      },
      async put(doc) {
        if (db.failPutFor.has(doc._id)) throw new Error('conflict')
        db.puts.push({ ...doc })
        store.notes.set(doc._id, { ...doc, timestamp: 1 })
        return { ok: true, id: doc._id, rev: '2-x' }
      },
      // Like the real index: returns every note with the tag, Trash included.
      async findAllIdsWithTag(tagId) {
        return [...store.notes.values()]
          .filter(n => (n.tags || []).includes(tagId))
          .map(n => n._id)
      }
    },
    tags: {
      createId: () => `tag:new${++seq}`,
      async findWithName(name) {
        return [...store.tags.values()].find(t => t.name === name)
      },
      async put(doc) {
        store.tags.set(doc._id, { ...doc })
        return { ok: true, id: doc._id, rev: '1-x' }
      }
    },
    books: {
      async get(id) {
        const b = store.books.get(id)
        if (!b) throw new Error(`missing ${id}`)
        return { ...b }
      },
      async findWithName(name) {
        return [...store.books.values()].find(b => b.name === name)
      },
      async all() {
        return [...store.books.values()]
      }
    }
  }
  return db
}

const TAG = { _id: 'tag:sp', name: 'scratchpad', color: 'default', createdAt: 1, updatedAt: 1 }
const INBOX = { _id: 'book:inbox', name: 'Inbox' }

function note(id, overrides = {}) {
  return {
    _id: `note:${id}`,
    _rev: '1-a',
    bookId: 'book:inbox',
    title: `Note ${id}`,
    doctype: 'markdown',
    body: 'text',
    tags: ['tag:sp'],
    createdAt: NOW - 100 * HOUR,
    updatedAt: NOW - 100 * HOUR,
    ...overrides
  }
}

const sweepOpts = extra => ({ tagName: 'scratchpad', ttlMs: TTL, now: NOW, ...extra })

test('moves a scratchpad untouched for more than 24h to Trash', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('old', { tags: ['tag:sp', 'tag:other'] })] })
  const result = await core.sweep(db, sweepOpts())
  assert.deepEqual(result.trashed, [{ _id: 'note:old', title: 'Note old' }])
  const stored = db.store.notes.get('note:old')
  assert.equal(stored.bookId, 'trash')
  assert.equal(stored.body, 'text')
  assert.equal(stored.updatedAt, NOW - 100 * HOUR)
  // The scratchpad tag is dropped so a restored note is not swept again.
  assert.deepEqual(stored.tags, ['tag:other'])
})

test('keeps a scratchpad edited within the last 24h, even if created long ago', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('fresh', { updatedAt: NOW - 23 * HOUR })] })
  const result = await core.sweep(db, sweepOpts())
  assert.equal(result.trashed.length, 0)
  assert.equal(db.puts.length, 0)
})

test('expires exactly at the 24h mark, not before', async () => {
  const db = fakeDB({
    tags: [TAG],
    notes: [
      note('edge', { createdAt: NOW - TTL, updatedAt: NOW - TTL }),
      note('almost', { createdAt: NOW - TTL + 1, updatedAt: NOW - TTL + 1 })
    ]
  })
  const result = await core.sweep(db, sweepOpts())
  assert.deepEqual(result.trashed.map(n => n._id), ['note:edge'])
})

test('never touches notes without the scratchpad tag', async () => {
  const db = fakeDB({
    tags: [TAG],
    notes: [note('plain', { tags: [], title: 'Scratchpad 21.04.2026' }), note('none', { tags: undefined })]
  })
  const result = await core.sweep(db, sweepOpts())
  assert.equal(result.trashed.length, 0)
  assert.equal(db.puts.length, 0)
})

test('does nothing when the tag does not exist, and does not create it', async () => {
  const db = fakeDB({ notes: [note('old')] })
  const result = await core.sweep(db, sweepOpts())
  assert.equal(result.trashed.length, 0)
  assert.equal(db.store.tags.size, 0)
})

test('leaves notes already in Trash and templates alone', async () => {
  const db = fakeDB({
    tags: [TAG],
    notes: [note('trashed', { bookId: 'trash' }), note('tpl', { bookId: 'template' })]
  })
  const result = await core.sweep(db, sweepOpts())
  assert.equal(result.trashed.length, 0)
  assert.equal(db.puts.length, 0)
})

test('skips the note that is open in the editor', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('open'), note('other')] })
  const result = await core.sweep(db, sweepOpts({ skipNoteIds: ['note:open', undefined] }))
  assert.deepEqual(result.trashed.map(n => n._id), ['note:other'])
  assert.equal(db.store.notes.get('note:open').bookId, 'book:inbox')
})

test('a note with no usable dates never expires', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('nodate', { createdAt: undefined, updatedAt: undefined })] })
  const result = await core.sweep(db, sweepOpts())
  assert.equal(result.trashed.length, 0)
})

test('one failing note does not stop the rest', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('a'), note('b'), note('c')] })
  db.failPutFor.add('note:b')
  const result = await core.sweep(db, sweepOpts())
  assert.deepEqual(result.trashed.map(n => n._id), ['note:a', 'note:c'])
  assert.deepEqual(result.errors, [{ id: 'note:b', message: 'conflict' }])
})

test('refuses a lifetime below one minute', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('old')] })
  for (const ttlMs of [0, -1, NaN, undefined, 59_999]) {
    await assert.rejects(core.sweep(db, sweepOpts({ ttlMs })))
  }
  assert.equal(db.puts.length, 0)
})

test('a restored note is not swept a second time', async () => {
  const db = fakeDB({ tags: [TAG], notes: [note('old')] })
  await core.sweep(db, sweepOpts())
  const restored = db.store.notes.get('note:old')
  db.store.notes.set('note:old', { ...restored, bookId: 'book:inbox' })
  const again = await core.sweep(db, sweepOpts({ now: NOW + HOUR }))
  assert.equal(again.trashed.length, 0)
})

const padOpts = extra => ({ tagName: 'scratchpad', notebook: 'Inbox', title: 'Scratchpad', now: NOW, ...extra })

test('creates the scratchpad in Inbox with the tag when there is none', async () => {
  const db = fakeDB({ books: [INBOX, { _id: 'book:work', name: 'Work' }] })
  const { note: created, created: isNew } = await core.openOrCreate(db, padOpts())
  assert.equal(isNew, true)
  assert.equal(created.title, 'Scratchpad')
  assert.equal(created.bookId, 'book:inbox')
  assert.equal(created.createdAt, NOW)
  assert.equal(created.updatedAt, NOW)
  const tag = [...db.store.tags.values()][0]
  assert.equal(tag.name, 'scratchpad')
  assert.deepEqual(created.tags, [tag._id])
})

test('there is only ever one scratchpad: later calls return the same note', async () => {
  const db = fakeDB({ books: [INBOX] })
  const first = await core.openOrCreate(db, padOpts())
  const nextDay = await core.openOrCreate(db, padOpts({ now: NOW + 23 * HOUR }))
  const renamed = db.store.notes.get(first.note._id)
  db.store.notes.set(first.note._id, { ...renamed, title: 'Something else' })
  const afterRename = await core.openOrCreate(db, padOpts({ now: NOW + 23 * HOUR }))
  assert.equal(nextDay.created, false)
  assert.equal(nextDay.note._id, first.note._id)
  assert.equal(afterRename.note._id, first.note._id)
  assert.equal(db.store.notes.size, 1)
  assert.equal(db.store.tags.size, 1)
})

test('a scratchpad in Trash does not count; a new one is created', async () => {
  const db = fakeDB({ tags: [TAG], books: [INBOX], notes: [note('gone', { title: 'Scratchpad', bookId: 'trash' })] })
  const result = await core.openOrCreate(db, padOpts())
  assert.equal(result.created, true)
  assert.notEqual(result.note._id, 'note:gone')
})

test('with several tagged notes, the most recently edited one is the scratchpad', async () => {
  const db = fakeDB({
    tags: [TAG],
    books: [INBOX],
    notes: [note('older', { updatedAt: NOW - 5 * HOUR }), note('newer', { updatedAt: NOW - HOUR })]
  })
  const pads = await core.findScratchpads(db, 'scratchpad')
  assert.deepEqual(pads.map(n => n._id), ['note:newer', 'note:older'])
  assert.equal((await core.openOrCreate(db, padOpts())).note._id, 'note:newer')
})

test('after the scratchpad expires there is none, and the next open makes a fresh one', async () => {
  const db = fakeDB({ books: [INBOX] })
  const first = await core.openOrCreate(db, padOpts())
  const early = await core.sweep(db, sweepOpts({ now: NOW + 23 * HOUR }))
  assert.equal(early.trashed.length, 0)
  const late = await core.sweep(db, sweepOpts({ now: NOW + 25 * HOUR }))
  assert.deepEqual(late.trashed.map(n => n._id), [first.note._id])
  assert.deepEqual(await core.findScratchpads(db, 'scratchpad'), [])
  const second = await core.openOrCreate(db, padOpts({ now: NOW + 26 * HOUR }))
  assert.equal(second.created, true)
  assert.notEqual(second.note._id, first.note._id)
})

test('recognises the titles the plugin itself gives a scratchpad', () => {
  for (const title of ['Scratchpad', 'scratchpad', ' Scratchpad ', 'Scratchpad 11.11.2026', '', undefined]) {
    assert.equal(core.isDefaultTitle(title, 'Scratchpad'), true, JSON.stringify(title))
  }
  for (const title of ['Scratchpad ideas', 'Meeting notes', 'Scratchpad 1.1.2026', 'My Scratchpad']) {
    assert.equal(core.isDefaultTitle(title, 'Scratchpad'), false, title)
  }
  assert.equal(core.isDefaultTitle('Notes (tmp)', 'Notes (tmp)'), true)
  assert.equal(core.isDefaultTitle('Notes xtmpx', 'Notes (tmp)'), false)
})

test('keeping turns the scratchpad into a normal untitled note in Inbox', async () => {
  const db = fakeDB({
    tags: [TAG],
    books: [INBOX, { _id: 'book:work', name: 'Work' }],
    notes: [note('pad', { title: 'Scratchpad', bookId: 'book:work', body: 'keep me', tags: ['tag:sp', 'tag:other'] })]
  })
  const kept = await core.keep(db, 'note:pad', 'tag:sp', { bookId: 'book:inbox', defaultTitle: 'Scratchpad', now: NOW })
  assert.equal(kept.title, '')
  assert.equal(kept.bookId, 'book:inbox')
  assert.deepEqual(kept.tags, ['tag:other'])
  assert.equal(kept.body, 'keep me')
  assert.equal(kept.updatedAt, NOW)
  assert.deepEqual(db.store.notes.get('note:pad').tags, ['tag:other'])
  // It is no longer a scratchpad: nothing to find, nothing to sweep, ever.
  assert.deepEqual(await core.findScratchpads(db, 'scratchpad'), [])
  const later = await core.sweep(db, sweepOpts({ now: NOW + 1000 * HOUR }))
  assert.equal(later.trashed.length, 0)
  assert.equal(db.store.notes.get('note:pad').bookId, 'book:inbox')
})

test('keeping leaves a title the user already wrote', () => {
  const patch = core.keepPatch(
    { title: 'Call notes', tags: ['tag:sp'], bookId: 'book:work' },
    'tag:sp',
    { bookId: 'book:inbox', defaultTitle: 'Scratchpad' }
  )
  assert.deepEqual(patch, { title: 'Call notes', tags: [], bookId: 'book:inbox' })
  const untagged = core.keepPatch({ title: 'Scratchpad' }, 'tag:sp', { bookId: 'book:inbox', defaultTitle: 'Scratchpad' })
  assert.deepEqual(untagged, { title: '', tags: [], bookId: 'book:inbox' })
})

test('after keeping, the next open creates a new scratchpad', async () => {
  const db = fakeDB({ books: [INBOX] })
  const first = await core.openOrCreate(db, padOpts())
  const tag = await core.findTag(db, 'scratchpad')
  await core.keep(db, first.note._id, tag._id, { bookId: 'book:inbox', defaultTitle: 'Scratchpad', now: NOW })
  const second = await core.openOrCreate(db, padOpts())
  assert.equal(second.created, true)
  assert.notEqual(second.note._id, first.note._id)
  assert.equal(db.store.notes.size, 2)
})

test('resolves the notebook by ID, by name, then falls back', async () => {
  const work = { _id: 'book:work', name: 'Work' }
  assert.equal(await core.resolveBookId(fakeDB({ books: [INBOX, work] }), 'book:work'), 'book:work')
  assert.equal(await core.resolveBookId(fakeDB({ books: [INBOX, work] }), 'Work'), 'book:work')
  assert.equal(await core.resolveBookId(fakeDB({ books: [INBOX, work] }), 'Nope'), 'book:inbox')
  assert.equal(await core.resolveBookId(fakeDB({ books: [work] }), ''), 'book:work')
  await assert.rejects(core.resolveBookId(fakeDB(), 'Inbox'))
})
