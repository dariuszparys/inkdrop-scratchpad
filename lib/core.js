'use strict'

/**
 * Scratchpad logic, kept free of any Inkdrop UI so it can be tested with a
 * fake database. `db` is Inkdrop's `env.localDB` (or anything shaped like it).
 */

// Special notebook IDs, as defined by inkdrop-model.
const TRASH_BOOK_ID = 'trash'
const TEMPLATE_BOOK_ID = 'template'

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** The later of the note's creation and last-edit times, or 0 if neither is usable. */
function lastTouched(note) {
  const updated = Number.isFinite(note.updatedAt) ? note.updatedAt : 0
  const created = Number.isFinite(note.createdAt) ? note.createdAt : 0
  return Math.max(updated, created)
}

/** A note that is neither in Trash nor a template. */
function isLive(note) {
  return (
    !!note &&
    note.bookId !== TRASH_BOOK_ID &&
    note.bookId !== TEMPLATE_BOOK_ID
  )
}

function hasTag(note, tagId) {
  return Array.isArray(note.tags) && note.tags.includes(tagId)
}

/**
 * True only for a live note that still carries the tag and has not been
 * touched for at least `ttlMs`. A note without a usable date never expires.
 */
function shouldExpire(note, tagId, now, ttlMs) {
  if (!isLive(note) || !hasTag(note, tagId)) return false
  const touched = lastTouched(note)
  if (touched <= 0) return false
  return now - touched >= ttlMs
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when the title is still the one the plugin gave the note: the plain
 * scratchpad title, or the dated form used by version 0.1.
 */
function isDefaultTitle(title, defaultTitle) {
  const current = String(title || '').trim()
  if (current === '') return true
  const pattern = new RegExp(`^${escapeRegExp(defaultTitle)}( \\d{2}\\.\\d{2}\\.\\d{4})?$`, 'i')
  return pattern.test(current)
}

async function findTag(db, tagName) {
  const tag = await db.tags.findWithName(tagName)
  return tag && tag._id ? tag : null
}

async function ensureTag(db, tagName, now = Date.now()) {
  const existing = await findTag(db, tagName)
  if (existing) return existing
  const tag = {
    _id: db.tags.createId(),
    name: tagName,
    color: 'default',
    createdAt: now,
    updatedAt: now
  }
  await db.tags.put(tag)
  return tag
}

/**
 * Resolves the notebook for new scratchpads: a notebook ID, else a notebook
 * name, else Inbox, else the first notebook there is.
 */
async function resolveBookId(db, notebook) {
  const wanted = String(notebook || '').trim()
  if (wanted.startsWith('book:')) {
    try {
      const book = await db.books.get(wanted)
      if (book && book._id) return book._id
    } catch (_) {
      // fall through to the other lookups
    }
  } else if (wanted) {
    const found = await db.books.findWithName(wanted)
    const book = Array.isArray(found) ? found[0] : found
    if (book && book._id) return book._id
  }
  try {
    const inbox = await db.books.get('book:inbox')
    if (inbox && inbox._id) return inbox._id
  } catch (_) {
    // no default Inbox notebook
  }
  const all = await db.books.all()
  const list = Array.isArray(all) ? all : (all && all.rows) || []
  const first = list[0] && (list[0].doc || list[0])
  if (first && first._id) return first._id
  throw new Error('No notebook found to put the scratchpad in')
}

/**
 * All live notes carrying the scratchpad tag, most recently touched first.
 * Normally there is one; there can be more if the tag was added by hand.
 */
async function findScratchpads(db, tagName) {
  const tag = await findTag(db, tagName)
  if (!tag) return []
  const ids = await db.notes.findAllIdsWithTag(tag._id)
  const notes = []
  for (const id of ids) {
    try {
      const note = await db.notes.get(id)
      if (isLive(note) && hasTag(note, tag._id)) notes.push(note)
    } catch (_) {
      // a note that vanished between the index lookup and the read
    }
  }
  return notes.sort((x, y) => lastTouched(y) - lastTouched(x))
}

/**
 * Returns the scratchpad, creating it if there is none.
 * @returns {Promise<{note: object, created: boolean}>}
 */
async function openOrCreate(db, options) {
  const { tagName, notebook, title, now = Date.now() } = options
  const existing = await findScratchpads(db, tagName)
  if (existing.length > 0) return { note: existing[0], created: false }

  const tag = await ensureTag(db, tagName, now)
  const note = {
    _id: db.notes.createId(),
    bookId: await resolveBookId(db, notebook),
    title,
    doctype: 'markdown',
    body: '',
    tags: [tag._id],
    status: 'none',
    share: 'private',
    numOfTasks: 0,
    numOfCheckedTasks: 0,
    createdAt: now,
    updatedAt: now
  }
  const res = await db.notes.put(note)
  if (res && res.rev) note._rev = res.rev
  return { note, created: true }
}

/**
 * The field changes that turn a scratchpad into an ordinary note: drop the
 * tag, move it to the keep notebook, and blank the title if it is still the
 * default one so the user can type a real title.
 */
function keepPatch(note, tagId, { bookId, defaultTitle }) {
  return {
    title: isDefaultTitle(note.title, defaultTitle) ? '' : note.title,
    tags: (Array.isArray(note.tags) ? note.tags : []).filter(t => t !== tagId),
    bookId
  }
}

/**
 * Turns a scratchpad into an ordinary note in the database. Use this only for
 * a note that is not open in the editor; an open note is changed through the
 * editor so unsaved text is not lost.
 * @returns {Promise<object>} the note as saved
 */
async function keep(db, noteId, tagId, options) {
  const { now = Date.now() } = options
  const note = await db.notes.get(noteId)
  const kept = { ...note, ...keepPatch(note, tagId, options), updatedAt: now }
  const res = await db.notes.put(kept)
  if (res && res.rev) kept._rev = res.rev
  return kept
}

/**
 * Moves expired scratchpads to Trash. Never deletes permanently.
 *
 * The tag is removed as the note is trashed, so a note the user restores from
 * Trash is an ordinary note again and is not swept a second time.
 *
 * @returns {Promise<{checked: number, trashed: {_id: string, title: string}[], errors: {id: string, message: string}[]}>}
 */
async function sweep(db, options) {
  const { tagName, ttlMs, now = Date.now(), skipNoteIds = [] } = options
  const result = { checked: 0, trashed: [], errors: [] }
  if (!Number.isFinite(ttlMs) || ttlMs < MINUTE_MS) {
    throw new Error(`Refusing to sweep with a lifetime below one minute (${ttlMs} ms)`)
  }

  const tag = await findTag(db, tagName)
  if (!tag) return result

  const skip = new Set(skipNoteIds.filter(Boolean))
  const ids = await db.notes.findAllIdsWithTag(tag._id)
  for (const id of ids) {
    if (skip.has(id)) continue
    try {
      // Read the note right before writing, so the check uses its latest state.
      const note = await db.notes.get(id)
      result.checked++
      if (!shouldExpire(note, tag._id, now, ttlMs)) continue
      await db.notes.put({
        ...note,
        bookId: TRASH_BOOK_ID,
        tags: note.tags.filter(t => t !== tag._id)
      })
      result.trashed.push({ _id: note._id, title: note.title })
    } catch (err) {
      result.errors.push({ id, message: (err && err.message) || String(err) })
    }
  }
  return result
}

module.exports = {
  TRASH_BOOK_ID,
  TEMPLATE_BOOK_ID,
  HOUR_MS,
  MINUTE_MS,
  lastTouched,
  isLive,
  shouldExpire,
  isDefaultTitle,
  findTag,
  ensureTag,
  resolveBookId,
  findScratchpads,
  openOrCreate,
  keepPatch,
  keep,
  sweep
}
