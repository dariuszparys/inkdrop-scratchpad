'use strict'

const core = require('./core')

const NAMESPACE = 'scratchpad'

// Wait after startup before the first sweep, so the local database has had
// time to pull edits made on other devices.
const FIRST_SWEEP_DELAY_MS = 2 * core.MINUTE_MS
const SYNC_RETRY_MS = core.MINUTE_MS
const MAX_SYNC_DEFERRALS = 5

// How long to wait for the editor to show a note after asking it to open one.
const OPEN_TIMEOUT_MS = 3000
const OPEN_POLL_MS = 50

const DEFAULTS = {
  ttlHours: 24,
  sweepIntervalMinutes: 60,
  tagName: 'scratchpad',
  title: 'Scratchpad',
  notebook: 'Inbox',
  keepNotebook: 'Inbox',
  notify: true
}

class ScratchpadPlugin {
  config = {
    ttlHours: {
      title: 'Lifetime (hours)',
      description:
        'The scratchpad moves to Trash once it has gone this long without an edit.',
      type: 'number',
      default: DEFAULTS.ttlHours,
      minimum: 0.1
    },
    sweepIntervalMinutes: {
      title: 'Check interval (minutes)',
      description: 'How often to look for an expired scratchpad while Inkdrop is open.',
      type: 'integer',
      default: DEFAULTS.sweepIntervalMinutes,
      minimum: 1
    },
    tagName: {
      title: 'Tag',
      description: 'The tag that marks the scratchpad. Only notes with this tag ever expire.',
      type: 'string',
      default: DEFAULTS.tagName
    },
    title: {
      title: 'Scratchpad title',
      description: 'Title given to a new scratchpad.',
      type: 'string',
      default: DEFAULTS.title
    },
    notebook: {
      title: 'Scratchpad notebook',
      description: 'Name or ID of the notebook the scratchpad is created in.',
      type: 'string',
      default: DEFAULTS.notebook
    },
    keepNotebook: {
      title: 'Keep notebook',
      description: 'Name or ID of the notebook a kept scratchpad is moved to.',
      type: 'string',
      default: DEFAULTS.keepNotebook
    },
    notify: {
      title: 'Notify on cleanup',
      description: 'Show a notification when the scratchpad is moved to Trash.',
      type: 'boolean',
      default: DEFAULTS.notify
    }
  }

  env = null
  commands = null
  timer = null
  sweeping = false
  syncDeferrals = 0

  activate(env) {
    this.env = env || globalThis.inkdrop
    this.commands = this.env.commands.add(document.body, {
      'scratchpad:open': {
        description: 'Open the scratchpad, creating it if there is none',
        didDispatch: () => this.openScratchpad()
      },
      'scratchpad:keep': {
        description: 'Keep the scratchpad as a normal note and give it a title',
        didDispatch: () => this.keepScratchpad()
      },
      'scratchpad:sweep-now': {
        description: 'Move an expired scratchpad to Trash now',
        didDispatch: () => this.runSweep({ manual: true })
      }
    })
    // Every window activates its own copy of the plugin, but only the main
    // window sweeps. `isMainWindow` is resolved asynchronously during startup
    // and may still hold its default here, so it is checked in tick() instead.
    this.schedule(FIRST_SWEEP_DELAY_MS)
  }

  deactivate() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.commands) this.commands.dispose()
    this.commands = null
    this.env = null
  }

  setting(key) {
    const value = this.env.config.get(`${NAMESPACE}.${key}`)
    return value === undefined || value === null || value === '' ? DEFAULTS[key] : value
  }

  settings() {
    let ttlHours = Number(this.setting('ttlHours'))
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) ttlHours = DEFAULTS.ttlHours
    let interval = Number(this.setting('sweepIntervalMinutes'))
    if (!Number.isFinite(interval) || interval < 1) interval = DEFAULTS.sweepIntervalMinutes
    return {
      ttlMs: Math.max(core.MINUTE_MS, ttlHours * core.HOUR_MS),
      intervalMs: interval * core.MINUTE_MS,
      tagName: String(this.setting('tagName')).trim() || DEFAULTS.tagName,
      title: String(this.setting('title')).trim() || DEFAULTS.title,
      notebook: String(this.setting('notebook')).trim(),
      keepNotebook: String(this.setting('keepNotebook')).trim(),
      notify: this.setting('notify') !== false
    }
  }

  state() {
    try {
      return this.env.store.getState() || {}
    } catch (_) {
      return {}
    }
  }

  /** Inkdrop's own store actions, as exported to plugins. */
  actions() {
    return require('inkdrop').actions
  }

  dispatchCommand(name, detail) {
    this.env.commands.dispatch(document.body, name, detail)
  }

  notifyError(what, err) {
    console.error(`[scratchpad] ${what}:`, err)
    this.env.notifications.addError('Scratchpad', {
      detail: `${what}: ${(err && err.message) || err}`,
      dismissable: true
    })
  }

  /** Resolves once the editor shows the given note, or after a timeout. */
  async waitForEditing(noteId) {
    const deadline = Date.now() + OPEN_TIMEOUT_MS
    while (Date.now() < deadline) {
      const editing = this.state().editingNote
      if (editing && editing._id === noteId) return true
      await new Promise(resolve => setTimeout(resolve, OPEN_POLL_MS))
    }
    return false
  }

  schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tick(), delayMs)
  }

  async tick() {
    this.timer = null
    if (!this.env) return
    // Secondary windows stop here and never reschedule.
    if (!this.env.isMainWindow) return
    const db = this.state().db
    if (db && db.isSyncing === true && this.syncDeferrals < MAX_SYNC_DEFERRALS) {
      this.syncDeferrals++
      this.schedule(SYNC_RETRY_MS)
      return
    }
    this.syncDeferrals = 0
    await this.runSweep({ manual: false })
    if (this.env) this.schedule(this.settings().intervalMs)
  }

  async runSweep({ manual }) {
    const env = this.env
    if (!env || this.sweeping) return
    this.sweeping = true
    try {
      const { ttlMs, tagName, notify } = this.settings()
      const editing = this.state().editingNote
      const result = await core.sweep(env.localDB, {
        tagName,
        ttlMs,
        skipNoteIds: [editing && editing._id]
      })
      const count = result.trashed.length
      if (result.errors.length > 0) {
        console.warn('[scratchpad] Some notes could not be moved to Trash:', result.errors)
      }
      if (count > 0 && (notify || manual)) {
        env.notifications.addInfo('Scratchpad', {
          detail:
            count === 1
              ? 'The scratchpad expired and was moved to Trash.'
              : `${count} expired scratchpads were moved to Trash.`,
          dismissable: true
        })
      } else if (manual) {
        env.notifications.addInfo('Scratchpad', {
          detail:
            result.errors.length > 0
              ? 'The expired scratchpad could not be moved to Trash.'
              : 'Nothing has expired.',
          dismissable: true
        })
      }
    } catch (err) {
      console.error('[scratchpad] Sweep failed:', err)
      if (manual) this.notifyError('Cleanup failed', err)
    } finally {
      this.sweeping = false
    }
  }

  async openScratchpad() {
    const env = this.env
    if (!env) return
    try {
      const { tagName, notebook, title } = this.settings()
      const { note } = await core.openOrCreate(env.localDB, { tagName, notebook, title })
      this.dispatchCommand('core:open-note', {
        noteId: note._id,
        selectInNoteListBar: true,
        pushState: true
      })
      // Put the cursor in the text, also when the scratchpad was already open.
      await this.waitForEditing(note._id)
      if (this.env) this.dispatchCommand('editor:focus')
    } catch (err) {
      this.notifyError('Could not open the scratchpad', err)
    }
  }

  async keepScratchpad() {
    const env = this.env
    if (!env) return
    try {
      const { tagName, keepNotebook, title } = this.settings()
      const db = env.localDB
      const pads = await core.findScratchpads(db, tagName)
      if (pads.length === 0) {
        env.notifications.addInfo('Scratchpad', {
          detail: 'There is no scratchpad to keep.',
          dismissable: true
        })
        return
      }
      const tag = await core.findTag(db, tagName)
      const options = {
        bookId: await core.resolveBookId(db, keepNotebook),
        defaultTitle: title
      }

      // Prefer the scratchpad that is open in the editor, else the newest.
      const editing = this.state().editingNote
      const open = editing && pads.find(p => p._id === editing._id)
      if (open) {
        // Change the open note through the editor, the way Inkdrop does for a
        // title or notebook change, so unsaved text is kept.
        const actions = this.actions()
        env.store.dispatch(actions.editingNote.update(core.keepPatch(editing, tag._id, options)))
        env.store.dispatch(actions.editor.change(true))
        this.dispatchCommand('core:save-note')
      } else {
        const kept = await core.keep(db, pads[0]._id, tag._id, options)
        this.dispatchCommand('core:open-note', {
          noteId: kept._id,
          selectInNoteListBar: true,
          pushState: true
        })
        await this.waitForEditing(kept._id)
      }
      if (this.env) this.dispatchCommand('editor:focus-title')
    } catch (err) {
      this.notifyError('Could not keep the scratchpad', err)
    }
  }
}

module.exports = new ScratchpadPlugin()
