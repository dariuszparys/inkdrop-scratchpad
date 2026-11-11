'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

globalThis.document = { body: { nodeName: 'BODY' } }

/** A stand-in for the Inkdrop environment handed to activate(). */
function fakeEnv({ isMainWindow = true, config = {}, notes = [], editingNote = null, syncing = false } = {}) {
  const store = new Map(notes.map(n => [n._id, { ...n }]))
  const tags = [{ _id: 'tag:sp', name: 'scratchpad' }]
  let seq = 0
  const env = {
    isMainWindow,
    registered: {},
    dispatched: [],
    storeActions: [],
    notices: [],
    disposed: false,
    reduxState: { editingNote, db: { isSyncing: syncing } },
    notes: store,
    commands: {
      add(target, commands) {
        assert.equal(target, document.body)
        Object.assign(env.registered, commands)
        return { dispose: () => (env.disposed = true) }
      },
      dispatch(target, name, detail) {
        assert.equal(target, document.body)
        env.dispatched.push({ name, detail })
        // Like the real editor: opening a note makes it the editing note.
        if (name === 'core:open-note') env.reduxState.editingNote = { ...store.get(detail.noteId) }
      }
    },
    config: { get: key => config[key] },
    store: {
      getState: () => env.reduxState,
      dispatch(action) {
        env.storeActions.push(action)
        if (action.type === 'editingNote.update') {
          env.reduxState.editingNote = { ...env.reduxState.editingNote, ...action.patch }
        }
      }
    },
    notifications: {
      addInfo: (title, opts) => env.notices.push({ level: 'info', title, ...opts }),
      addError: (title, opts) => env.notices.push({ level: 'error', title, ...opts })
    },
    localDB: {
      notes: {
        createId: () => `note:new${++seq}`,
        get: async id => {
          if (!store.has(id)) throw new Error(`missing ${id}`)
          return { ...store.get(id) }
        },
        put: async doc => (store.set(doc._id, { ...doc }), { ok: true, rev: '2-x' }),
        findAllIdsWithTag: async tagId =>
          [...store.values()].filter(n => (n.tags || []).includes(tagId)).map(n => n._id)
      },
      tags: {
        createId: () => 'tag:new',
        findWithName: async name => tags.find(t => t.name === name) || null,
        put: async doc => (tags.push(doc), { ok: true })
      },
      books: {
        get: async id => ({ _id: id }),
        findWithName: async name =>
          ({ Inbox: { _id: 'book:inbox', name }, Work: { _id: 'book:work', name } })[name] || null,
        all: async () => [{ _id: 'book:inbox', name: 'Inbox' }]
      }
    }
  }
  return env
}

function pad(id, ageHours, overrides = {}) {
  const at = Date.now() - ageHours * HOUR
  return {
    _id: `note:${id}`,
    bookId: 'book:work',
    title: 'Scratchpad',
    doctype: 'markdown',
    body: 'text',
    tags: ['tag:sp'],
    createdAt: at,
    updatedAt: at,
    ...overrides
  }
}

function freshPlugin() {
  delete require.cache[require.resolve('../lib/index')]
  const plugin = require('../lib/index')
  // Stand-ins for Inkdrop's exported store actions.
  plugin.actions = () => ({
    editingNote: { update: patch => ({ type: 'editingNote.update', patch }) },
    editor: { change: flag => ({ type: 'editor.change', flag }) }
  })
  return plugin
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const run = (env, command) => env.registered[command].didDispatch({})
const names = env => env.dispatched.map(d => d.name)

test('exposes a settings schema with safe defaults', () => {
  const plugin = freshPlugin()
  assert.equal(plugin.config.ttlHours.default, 24)
  assert.equal(plugin.config.tagName.default, 'scratchpad')
  assert.equal(plugin.config.title.default, 'Scratchpad')
  assert.equal(plugin.config.keepNotebook.default, 'Inbox')
})

test('registers its commands and cleans up on deactivate', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv()
  plugin.activate(env)
  assert.deepEqual(Object.keys(env.registered).sort(), [
    'scratchpad:keep',
    'scratchpad:open',
    'scratchpad:sweep-now'
  ])
  assert.notEqual(plugin.timer, null)
  plugin.deactivate()
  assert.equal(env.disposed, true)
  assert.equal(plugin.timer, null)
})

test('every command named in the keymap and menu is registered', () => {
  const plugin = freshPlugin()
  const env = fakeEnv()
  plugin.activate(env)
  const keymap = require('../keymaps/scratchpad.json')
  const menu = JSON.stringify(require('../menus/scratchpad.json'))
  const used = new Set([
    ...Object.values(keymap).flatMap(bindings => Object.values(bindings)),
    ...[...menu.matchAll(/"command":"([^"]+)"/g)].map(m => m[1])
  ])
  for (const command of used) assert.ok(env.registered[command], `${command} is registered`)
  assert.equal(keymap['.platform-darwin']['cmd-alt-s'], 'scratchpad:open')
  assert.equal(keymap['.platform-darwin']['cmd-alt-shift-s'], 'scratchpad:keep')
  plugin.deactivate()
})

test('open creates the scratchpad once, then always reopens the same note', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv()
  plugin.activate(env)
  await run(env, 'scratchpad:open')
  await run(env, 'scratchpad:open')
  const all = [...env.notes.values()]
  assert.equal(all.length, 1)
  assert.equal(all[0].title, 'Scratchpad')
  assert.equal(all[0].bookId, 'book:inbox')
  assert.deepEqual(all[0].tags, ['tag:sp'])
  assert.deepEqual(names(env), ['core:open-note', 'editor:focus', 'core:open-note', 'editor:focus'])
  assert.equal(env.dispatched[0].detail.noteId, all[0]._id)
  plugin.deactivate()
})

test('keep on the open scratchpad goes through the editor and focuses the title', async () => {
  const plugin = freshPlugin()
  const open = pad('p', 1, { tags: ['tag:sp', 'tag:other'] })
  const env = fakeEnv({ notes: [open], editingNote: { ...open, body: 'unsaved edit' } })
  plugin.activate(env)
  await run(env, 'scratchpad:keep')

  assert.deepEqual(env.storeActions, [
    { type: 'editingNote.update', patch: { title: '', tags: ['tag:other'], bookId: 'book:inbox' } },
    { type: 'editor.change', flag: true }
  ])
  // The unsaved text stays in the editor; the plugin never wrote over it.
  assert.equal(env.reduxState.editingNote.body, 'unsaved edit')
  assert.deepEqual(env.notes.get('note:p').tags, ['tag:sp', 'tag:other'])
  assert.deepEqual(names(env), ['core:save-note', 'editor:focus-title'])
  plugin.deactivate()
})

test('keep on a scratchpad that is not open converts it, opens it and focuses the title', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('p', 1)], editingNote: { _id: 'note:elsewhere' } })
  plugin.activate(env)
  await run(env, 'scratchpad:keep')

  const kept = env.notes.get('note:p')
  assert.equal(kept.title, '')
  assert.equal(kept.bookId, 'book:inbox')
  assert.deepEqual(kept.tags, [])
  assert.equal(kept.body, 'text')
  assert.equal(env.storeActions.length, 0)
  assert.deepEqual(names(env), ['core:open-note', 'editor:focus-title'])
  assert.equal(env.dispatched[0].detail.noteId, 'note:p')
  plugin.deactivate()
})

test('keep honours the keep-notebook setting', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv({
    notes: [pad('p', 1, { bookId: 'book:inbox' })],
    config: { 'scratchpad.keepNotebook': 'Work' }
  })
  plugin.activate(env)
  await run(env, 'scratchpad:keep')
  assert.equal(env.notes.get('note:p').bookId, 'book:work')
  plugin.deactivate()
})

test('keep with no scratchpad says so and changes nothing', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('plain', 1, { tags: [] })] })
  plugin.activate(env)
  await run(env, 'scratchpad:keep')
  assert.match(env.notices[0].detail, /no scratchpad to keep/i)
  assert.equal(env.dispatched.length, 0)
  assert.deepEqual(env.notes.get('note:plain').tags, [])
  plugin.deactivate()
})

test('a kept note is no longer the scratchpad: open then makes a new one', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('p', 1)] })
  plugin.activate(env)
  await run(env, 'scratchpad:keep')
  await run(env, 'scratchpad:open')
  assert.equal(env.notes.size, 2)
  const fresh = [...env.notes.values()].find(n => n._id !== 'note:p')
  assert.deepEqual(fresh.tags, ['tag:sp'])
  assert.equal(fresh.title, 'Scratchpad')
  plugin.deactivate()
})

test('waits two minutes after startup, then sweeps hourly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('a', 30)] })
  plugin.activate(env)

  t.mock.timers.tick(2 * MINUTE - 1)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'book:work')

  t.mock.timers.tick(1)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'trash')
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].detail, /expired and was moved to Trash/)

  assert.notEqual(plugin.timer, null)
  t.mock.timers.tick(60 * MINUTE)
  await settle()
  assert.equal(env.notices.length, 1)
  plugin.deactivate()
})

test('a scratchpad edited within 24 hours is left alone by the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('a', 23)] })
  plugin.activate(env)
  t.mock.timers.tick(2 * MINUTE)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'book:work')
  assert.equal(env.notices.length, 0)
  plugin.deactivate()
})

test('never sweeps from a secondary window, and stops its timer there', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv({ isMainWindow: false, notes: [pad('a', 30)] })
  plugin.activate(env)
  t.mock.timers.tick(2 * MINUTE)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'book:work')
  assert.equal(plugin.timer, null)
  plugin.deactivate()
})

test('sweeps when the main-window flag only resolves after activation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv({ isMainWindow: false, notes: [pad('a', 30)] })
  plugin.activate(env)
  env.isMainWindow = true
  t.mock.timers.tick(2 * MINUTE)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'trash')
  plugin.deactivate()
})

test('holds off while a sync is running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('a', 30)], syncing: true })
  plugin.activate(env)
  t.mock.timers.tick(2 * MINUTE)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'book:work')

  env.reduxState.db.isSyncing = false
  t.mock.timers.tick(MINUTE)
  await settle()
  assert.equal(env.notes.get('note:a').bookId, 'trash')
  plugin.deactivate()
})

test('never sweeps the scratchpad while it is open in the editor', async () => {
  const plugin = freshPlugin()
  const env = fakeEnv({ notes: [pad('open', 30)], editingNote: { _id: 'note:open' } })
  plugin.activate(env)
  await run(env, 'scratchpad:sweep-now')
  assert.equal(env.notes.get('note:open').bookId, 'book:work')
  assert.match(env.notices[0].detail, /Nothing has expired/)
  plugin.deactivate()
})

test('honours a custom lifetime and ignores nonsense values', async () => {
  for (const [ttl, expectTrashed] of [[48, false], [12, true], [0, false], ['abc', false], [-5, false]]) {
    const plugin = freshPlugin()
    const env = fakeEnv({ config: { 'scratchpad.ttlHours': ttl }, notes: [pad('a', 20)] })
    plugin.activate(env)
    await run(env, 'scratchpad:sweep-now')
    assert.equal(env.notes.get('note:a').bookId === 'trash', expectTrashed, `ttlHours=${ttl}`)
    plugin.deactivate()
  }
})
