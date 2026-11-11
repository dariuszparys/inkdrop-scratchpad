# scratchpad

An Inkdrop plugin for one throwaway note. The scratchpad moves itself to Trash
once it has gone 24 hours without an edit. When something in it is worth
keeping, one shortcut turns it into a normal note.

Requires Inkdrop 6.

## Use it

| Shortcut (macOS) | Windows and Linux | What it does |
|---|---|---|
| <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> | Open the scratchpad, creating it if there is none |
| <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Keep the scratchpad as a normal note |

Both are also under **Plugins > Scratchpad**.

- **Open** always takes you to the same note, titled `Scratchpad`, with the
  cursor in the text. There is only ever one scratchpad.
- **Keep** removes the `scratchpad` tag, moves the note to Inbox, clears the
  title and puts the cursor in the title field. Type a title and the note is an
  ordinary note. The next **Open** starts a fresh scratchpad.

## How expiry works

- The scratchpad is the note with the `scratchpad` tag. Only a note with that
  tag ever expires.
- The clock starts at the last edit. Every edit gives it another 24 hours.
- An expired scratchpad moves to Trash and loses the tag. Nothing is deleted
  permanently; emptying Trash stays up to you. After that there is no
  scratchpad until you open one again.
- A note you restore from Trash is an ordinary note and stays.
- The scratchpad is never swept while it is open in the editor.
- Checks run about two minutes after Inkdrop starts and then once an hour.
  Nothing happens while Inkdrop is closed; an overdue scratchpad goes at the
  next start.
- The move to Trash syncs to your other devices.

If you add the `scratchpad` tag to more notes by hand, each of them expires by
the same rule, and **Open** picks the most recently edited one.

To check right away, choose **Plugins > Scratchpad > Clean Up Expired Scratchpad Now**.

## Settings

Under **Preferences > Plugins > scratchpad**:

| Setting | Default | Meaning |
|---|---|---|
| Lifetime (hours) | `24` | How long the scratchpad lasts after its last edit |
| Check interval (minutes) | `60` | How often to look for an expired scratchpad |
| Tag | `scratchpad` | The tag that marks the scratchpad |
| Scratchpad title | `Scratchpad` | Title given to a new scratchpad |
| Scratchpad notebook | `Inbox` | Name or ID of the notebook the scratchpad is created in |
| Keep notebook | `Inbox` | Name or ID of the notebook a kept scratchpad moves to |
| Notify on cleanup | on | Show a notification when the scratchpad is moved to Trash |

## Commands

| Command | What it does |
|---|---|
| `scratchpad:open` | Open the scratchpad, creating it if there is none |
| `scratchpad:keep` | Keep the scratchpad as a normal note and focus its title |
| `scratchpad:sweep-now` | Move an expired scratchpad to Trash now |

To change a shortcut, bind the command to another key in your `keymap.json`.

## Development

The plugin is plain CommonJS with no build step and no dependencies.

```sh
npm test
```

To install by hand, copy this folder to `packages/scratchpad` in Inkdrop's user
data directory and reload Inkdrop.
