/**
 * Application shell: the interactive parts of a multi-page app.
 *
 * DIVISION OF LABOUR, same as everywhere else in this project:
 *   - I write the STRUCTURE and the BEHAVIOUR (skeletons + JavaScript)
 *   - the model writes CONTENT (product name, copy, server/channel/role names)
 *
 * A 4B model cannot write a working client application. It cannot hold a state
 * machine, a router and a data model in an 8K context, and it silently emits
 * things like `transition-transform` that look right and do nothing. Asking it
 * for app logic would produce something that renders and does not work — the
 * worst possible failure, because it passes inspection.
 *
 * So the logic here is hand-written, deterministic, and testable. The model
 * supplies the words. That is the only split that survives contact with a small
 * model, and it is why the output below actually functions.
 */

export interface AppFile {
  path: string;
  contents: string;
}

/** Shared application chrome. Dark-first, since that is the idiom for chat apps. */
export function appCss(): string {
  return `
/* ---- App shell -------------------------------------------------------- */
/* FOUR columns, because the shell has four children: rail, channels, main,
   members. Declaring three made the members panel wrap onto a second grid row
   — it rendered below the sidebar at y=763 instead of down the right-hand side.
   Caught by reading the computed style in a real browser, not by any verifier:
   a wrapped grid item is valid CSS and renders without error. */
.app { display: grid; grid-template-columns: 72px 240px minmax(0, 1fr) 220px; height: 100dvh; overflow: hidden; }
@media (max-width: 1100px) {
  .app { grid-template-columns: 72px 240px minmax(0, 1fr); }
  .app .members { display: none; }
}
@media (max-width: 760px) {
  .app { grid-template-columns: 64px minmax(0, 1fr); }
  .app .channels { display: none; }
  .app.show-channels .channels { display: flex; }
}

.rail {
  background: var(--rail); display: flex; flex-direction: column; align-items: center;
  gap: var(--space-3); padding: var(--space-3) 0; overflow-y: auto; scrollbar-width: none;
}
.rail::-webkit-scrollbar { display: none; }
.rail-btn {
  width: 48px; height: 48px; min-width: 48px; min-height: 48px;
  border-radius: var(--radius-4); border: 0; cursor: pointer;
  background: var(--surface); color: var(--fg);
  font-weight: 700; font-size: var(--text-5); display: grid; place-items: center;
  transition: transform 160ms var(--ease-out), border-radius 160ms var(--ease-out), background-color 160ms var(--ease-out);
}
.rail-btn:hover { border-radius: var(--radius-3); transform: translateY(-1px); }
.rail-btn[aria-current="true"] { background: var(--accent); color: var(--accent-fg); border-radius: var(--radius-3); }
.rail-add { background: transparent; border: 1px dashed var(--border); color: var(--muted); }
.rail-sep { width: 32px; height: 1px; background: var(--border); flex: none; }

.channels { background: var(--sidebar); display: flex; flex-direction: column; min-width: 0; }
.channels-head {
  padding: var(--space-4); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  font-weight: 700; min-height: 56px;
}
.channels-list { flex: 1; overflow-y: auto; padding: var(--space-3); display: flex; flex-direction: column; gap: 2px; }
.channel-group { font-size: var(--text-6); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: var(--space-4) var(--space-2) var(--space-2); }
.channel {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-2);
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font: inherit; font-size: var(--text-5); text-align: left; width: 100%; min-height: 36px;
  transition: background-color 140ms var(--ease-out), color 140ms var(--ease-out);
}
.channel:hover { background: color-mix(in oklab, var(--fg) 8%, transparent); color: var(--fg); }
.channel[aria-current="true"] { background: color-mix(in oklab, var(--fg) 12%, transparent); color: var(--fg); }
.channel .hash { color: var(--muted); font-weight: 600; }

.me-bar { border-top: 1px solid var(--border); padding: var(--space-3); display: flex; align-items: center; gap: var(--space-3); }
.avatar { width: 32px; height: 32px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-size: var(--text-6); font-weight: 700; flex: none; }
.me-name { font-size: var(--text-5); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.main { display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.main-head { min-height: 56px; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: var(--space-3); }
.main-title { font-weight: 700; font-size: var(--text-4); }
.main-topic { color: var(--muted); font-size: var(--text-6); border-left: 1px solid var(--border); padding-left: var(--space-3); }

.messages { flex: 1; overflow-y: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
.msg { display: grid; grid-template-columns: 40px 1fr; gap: var(--space-3); }
.msg-body { min-width: 0; }
.msg-head { display: flex; align-items: baseline; gap: var(--space-2); }
.msg-author { font-weight: 600; }
.msg-time { font-size: var(--text-6); color: var(--muted); }
.msg-text { margin: var(--space-1) 0 0; overflow-wrap: anywhere; }

.composer { padding: var(--space-4); border-top: 1px solid var(--border); display: flex; gap: var(--space-3); }
.composer input {
  flex: 1; min-height: 48px; padding: 0 var(--space-4); font: inherit; font-size: var(--text-5);
  border-radius: var(--radius-3); border: 1px solid var(--border);
  background: var(--surface); color: var(--fg);
}
.composer input::placeholder { color: var(--muted); }

.members { border-left: 1px solid var(--border); background: var(--sidebar); padding: var(--space-4); overflow-y: auto; width: 220px; }
.member { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; }
.role-chip { font-size: var(--text-6); padding: 2px var(--space-2); border-radius: 999px; border: 1px solid currentColor; }

/* ---- Dialogs ---------------------------------------------------------- */
dialog { border: 1px solid var(--border); border-radius: var(--radius-4); background: var(--surface); color: var(--fg); padding: 0; max-width: 520px; width: calc(100% - var(--space-6)); }
dialog::backdrop { background: rgb(0 0 0 / 0.6); }
.dialog-head { padding: var(--space-5); border-bottom: 1px solid var(--border); font-weight: 700; font-size: var(--text-4); }
.dialog-body { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.dialog-foot { padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: var(--space-3); }
.field { display: flex; flex-direction: column; gap: var(--space-2); }
.field label { font-size: var(--text-6); color: var(--muted); font-weight: 600; }
.field input, .field select, .field textarea {
  min-height: 48px; padding: var(--space-3) var(--space-4); font: inherit; font-size: var(--text-5);
  border-radius: var(--radius-3); border: 1px solid var(--border); background: var(--bg); color: var(--fg);
}
.btn-ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
.btn-danger { background: var(--danger); color: #fff; }
.error-text { color: var(--danger); font-size: var(--text-6); min-height: 1.2em; }

/* ---- Auth ------------------------------------------------------------- */
.auth-wrap { min-height: 100dvh; display: grid; place-items: center; padding: var(--space-5); }
.auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-4); padding: var(--space-7); }
.auth-tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-6); }
.auth-tab { flex: 1; min-height: 44px; border-radius: var(--radius-3); border: 1px solid var(--border); background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
.auth-tab[aria-selected="true"] { background: var(--accent); color: var(--accent-fg); border-color: transparent; }

/* ---- Roles ------------------------------------------------------------ */
.role-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-3); }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: var(--space-3); }
.perm { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; }
.swatch { width: 20px; height: 20px; border-radius: 999px; flex: none; }
`;
}

/**
 * Extra colour tokens the app shell needs beyond the base palette.
 *
 * Catppuccin values: the rail uses `crust` (the darkest step) and the sidebar
 * uses `mantle`, so the three columns read as receding planes — rail furthest
 * back, then sidebar, then `base` for the message area. That depth ordering is
 * what makes a chat shell feel structured rather than flat, and Catppuccin
 * provides it as designed steps rather than arbitrary darkening.
 */
export function appTokensCss(): string {
  return `
/* Latte */
:root { --rail: #dce0e8; --sidebar: #e6e9ef; --danger: #d20f39; --online: #40a02b; }
/* Mocha */
@media (prefers-color-scheme: dark) {
  :root { --rail: #11111b; --sidebar: #181825; --danger: #f38ba8; --online: #a6e3a1; }
}`;
}
