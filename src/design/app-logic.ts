/**
 * Client application logic.
 *
 * Hand-written deliberately. This is a state machine plus a data model plus a
 * router — the exact shape of thing a 4B model produces convincingly and
 * incorrectly. It would emit code that renders and does not work, which is the
 * worst failure mode available because it passes visual inspection.
 *
 * Persistence is localStorage: no backend, no build step, works from file://.
 * Passwords are hashed only so they are not stored in plain sight — this is a
 * demo, and it is NOT authentication. That is stated in the UI rather than
 * implied away.
 */

export function appJs(): string {
  return String.raw`
(function () {
  'use strict';

  // ---- Storage ---------------------------------------------------------
  var KEY = 'chatapp.v1';
  var state = load();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* corrupt or unavailable storage falls through to a fresh state */ }
    return { users: [], session: null, servers: [], dms: [], nextId: 1 };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('storage unavailable, changes are session-only'); }
  }
  function uid(prefix) { return prefix + '_' + (state.nextId++); }

  // Not security. Enough to avoid storing readable passwords in a demo.
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  function now() { return new Date().toISOString(); }
  function timeLabel(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- Seeding ---------------------------------------------------------
  function seedIfEmpty() {
    if (state.servers.length > 0) return;
    var seed = window.__SEED__ || {};
    var servers = seed.servers || [];
    servers.forEach(function (s) {
      var server = {
        id: uid('srv'), name: s.name, icon: initials(s.name),
        roles: (s.roles || []).map(function (r) {
          return { id: uid('role'), name: r.name, color: r.color,
                   perms: { manage: !!r.manage, kick: !!r.kick, post: true } };
        }),
        channels: (s.channels || []).map(function (c) {
          return { id: uid('ch'), name: c.name, topic: c.topic || '', messages: [] };
        }),
        members: [],
      };
      (s.messages || []).forEach(function (m, i) {
        var ch = server.channels[i % Math.max(1, server.channels.length)];
        if (ch) ch.messages.push({ id: uid('msg'), author: m.author, text: m.text, at: now() });
      });
      state.servers.push(server);
    });
    (seed.dms || []).forEach(function (d) {
      state.dms.push({ id: uid('dm'), name: d.name, messages: [{ id: uid('msg'), author: d.name, text: d.text, at: now() }] });
    });
    save();
  }

  // ---- Auth ------------------------------------------------------------
  function register(name, email, password) {
    if (!name || !email || !password) return 'All fields are required.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (state.users.some(function (u) { return u.email === email; })) return 'That email is already registered.';
    var user = { id: uid('usr'), name: name, email: email, pass: hash(password) };
    state.users.push(user);
    state.session = user.id;
    save();
    return null;
  }
  function login(email, password) {
    var u = state.users.filter(function (x) { return x.email === email; })[0];
    if (!u || u.pass !== hash(password)) return 'Incorrect email or password.';
    state.session = u.id;
    save();
    return null;
  }
  function currentUser() {
    return state.users.filter(function (u) { return u.id === state.session; })[0] || null;
  }
  function logout() { state.session = null; save(); location.href = 'auth.html'; }

  // ---- Auth page -------------------------------------------------------
  function initAuth() {
    var tabs = document.querySelectorAll('.auth-tab');
    var forms = { login: document.getElementById('form-login'), register: document.getElementById('form-register') };
    function show(which) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === which)); });
      Object.keys(forms).forEach(function (k) { if (forms[k]) forms[k].hidden = k !== which; });
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.dataset.tab); }); });
    show(location.hash === '#register' ? 'register' : 'login');

    if (forms.login) forms.login.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = login(forms.login.email.value.trim(), forms.login.password.value);
      var out = forms.login.querySelector('.error-text');
      if (err) { out.textContent = err; return; }
      location.href = 'app.html';
    });
    if (forms.register) forms.register.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = forms.register;
      var err = register(f.name.value.trim(), f.email.value.trim(), f.password.value);
      var out = f.querySelector('.error-text');
      if (err) { out.textContent = err; return; }
      location.href = 'app.html';
    });
  }

  // ---- App -------------------------------------------------------------
  var view = { kind: 'server', serverId: null, channelId: null, dmId: null };

  function initApp() {
    var user = currentUser();
    if (!user) { location.href = 'auth.html'; return; }
    seedIfEmpty();
    if (state.servers[0]) {
      view.serverId = state.servers[0].id;
      view.channelId = state.servers[0].channels[0] ? state.servers[0].channels[0].id : null;
    }
    bind();
    render();
  }

  function activeServer() {
    return state.servers.filter(function (s) { return s.id === view.serverId; })[0] || null;
  }
  function activeChannel() {
    var s = activeServer();
    if (!s) return null;
    return s.channels.filter(function (c) { return c.id === view.channelId; })[0] || null;
  }
  function activeDm() {
    return state.dms.filter(function (d) { return d.id === view.dmId; })[0] || null;
  }

  function render() {
    renderMe();
    renderRail();
    renderSidebar();
    renderMain();
    renderMembers();
  }

  // The me-bar was present in the markup but never populated, so every session
  // showed a "?" avatar next to the literal word "You".
  function renderMe() {
    var me = currentUser();
    if (!me) return;
    var av = document.getElementById('me-avatar');
    var nm = document.getElementById('me-name');
    if (av) av.textContent = initials(me.name);
    if (nm) { nm.textContent = me.name; nm.title = me.email; }
  }

  function renderRail() {
    var rail = document.getElementById('rail');
    if (!rail) return;
    var html = '<button class="rail-btn" id="btn-dms" title="Direct messages" aria-current="' + (view.kind === 'dm') + '">DM</button>';
    html += '<div class="rail-sep" role="separator"></div>';
    state.servers.forEach(function (s) {
      html += '<button class="rail-btn" data-server="' + s.id + '" title="' + esc(s.name) + '" aria-current="' +
              (view.kind === 'server' && s.id === view.serverId) + '">' + esc(s.icon) + '</button>';
    });
    html += '<button class="rail-btn rail-add" id="btn-add-server" title="Create a server" aria-label="Create a server">+</button>';
    rail.innerHTML = html;
  }

  function renderSidebar() {
    var head = document.getElementById('sidebar-head');
    var list = document.getElementById('channel-list');
    if (!head || !list) return;

    if (view.kind === 'dm') {
      head.innerHTML = '<span>Direct messages</span>';
      list.innerHTML = state.dms.length
        ? state.dms.map(function (d) {
            return '<button class="channel" data-dm="' + d.id + '" aria-current="' + (d.id === view.dmId) + '">' +
                   '<span class="avatar" style="width:24px;height:24px;font-size:11px">' + esc(initials(d.name)) + '</span>' +
                   esc(d.name) + '</button>';
          }).join('')
        : '<p class="channel-group">No conversations yet</p>';
      return;
    }

    var s = activeServer();
    if (!s) { head.innerHTML = '<span>No server</span>'; list.innerHTML = ''; return; }
    head.innerHTML = '<span>' + esc(s.name) + '</span>' +
      '<button class="rail-btn" id="btn-server-settings" title="Server settings" ' +
      'style="width:32px;height:32px;min-width:32px;min-height:32px;font-size:14px" aria-label="Server settings">⚙</button>';

    list.innerHTML = '<div class="channel-group">Channels</div>' +
      s.channels.map(function (c) {
        return '<button class="channel" data-channel="' + c.id + '" aria-current="' + (c.id === view.channelId) + '">' +
               '<span class="hash">#</span>' + esc(c.name) + '</button>';
      }).join('') +
      '<button class="channel" id="btn-add-channel"><span class="hash">+</span>Add channel</button>';
  }

  function renderMain() {
    var title = document.getElementById('main-title');
    var topic = document.getElementById('main-topic');
    var msgs = document.getElementById('messages');
    if (!title || !msgs) return;

    var list, label, topicText = '';
    if (view.kind === 'dm') {
      var d = activeDm();
      list = d ? d.messages : [];
      label = d ? d.name : 'Direct messages';
    } else {
      var c = activeChannel();
      list = c ? c.messages : [];
      label = c ? '# ' + c.name : 'No channel';
      topicText = c ? c.topic : '';
    }

    title.textContent = label;
    topic.textContent = topicText;
    topic.hidden = !topicText;

    msgs.innerHTML = list.length
      ? list.map(function (m) {
          return '<div class="msg"><div class="avatar">' + esc(initials(m.author)) + '</div>' +
                 '<div class="msg-body"><div class="msg-head"><span class="msg-author">' + esc(m.author) +
                 '</span><span class="msg-time">' + esc(timeLabel(m.at)) + '</span></div>' +
                 '<p class="msg-text">' + esc(m.text) + '</p></div></div>';
        }).join('')
      : '<p class="channel-group">No messages yet. Say something.</p>';
    msgs.scrollTop = msgs.scrollHeight;
  }

  function renderMembers() {
    var el = document.getElementById('members');
    if (!el) return;
    var s = activeServer();
    if (view.kind === 'dm' || !s) { el.innerHTML = ''; return; }
    var me = currentUser();
    var rows = s.roles.map(function (r) {
      return '<div class="member"><span class="swatch" style="background:' + esc(r.color) + '"></span>' +
             '<span>' + esc(r.name) + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="channel-group">Roles</div>' + rows +
      '<div class="channel-group">Online</div>' +
      '<div class="member"><span class="avatar" style="width:24px;height:24px;font-size:11px">' +
      esc(initials(me.name)) + '</span><span>' + esc(me.name) + '</span></div>';
  }

  // ---- Events ----------------------------------------------------------
  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;

      if (t.id === 'btn-dms') { view.kind = 'dm'; view.dmId = state.dms[0] ? state.dms[0].id : null; render(); return; }
      if (t.dataset.server) { view.kind = 'server'; view.serverId = t.dataset.server;
        var s = activeServer(); view.channelId = s && s.channels[0] ? s.channels[0].id : null; render(); return; }
      if (t.dataset.channel) { view.channelId = t.dataset.channel; render(); return; }
      if (t.dataset.dm) { view.dmId = t.dataset.dm; render(); return; }
      if (t.id === 'btn-add-server') { openCreateServer(); return; }
      if (t.id === 'btn-add-channel') { openCreateChannel(); return; }
      if (t.id === 'btn-server-settings') { openSettings(); return; }
      if (t.id === 'btn-logout') { logout(); return; }
    });

    var composer = document.getElementById('composer');
    if (composer) composer.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = composer.querySelector('input');
      var text = input.value.trim();
      if (!text) return;
      var me = currentUser();
      var target = view.kind === 'dm' ? activeDm() : activeChannel();
      if (!target) return;
      target.messages.push({ id: uid('msg'), author: me.name, text: text, at: now() });
      input.value = '';
      save();
      renderMain();
    });
  }

  function openCreateServer() {
    var dlg = document.getElementById('dlg-server');
    if (!dlg) return;
    var form = dlg.querySelector('form');
    form.reset();
    dlg.showModal();
    form.onsubmit = function (e) {
      e.preventDefault();
      var name = form.servername.value.trim();
      if (!name) return;
      var srv = {
        id: uid('srv'), name: name, icon: initials(name),
        roles: [
          { id: uid('role'), name: 'Admin', color: '#f97066', perms: { manage: true, kick: true, post: true } },
          { id: uid('role'), name: 'Member', color: '#7ea6ff', perms: { manage: false, kick: false, post: true } },
        ],
        channels: [{ id: uid('ch'), name: 'general', topic: 'General discussion', messages: [] }],
        members: [],
      };
      state.servers.push(srv);
      view.kind = 'server'; view.serverId = srv.id; view.channelId = srv.channels[0].id;
      save(); dlg.close(); render();
    };
  }

  function openCreateChannel() {
    var dlg = document.getElementById('dlg-channel');
    var s = activeServer();
    if (!dlg || !s) return;
    var form = dlg.querySelector('form');
    form.reset();
    dlg.showModal();
    form.onsubmit = function (e) {
      e.preventDefault();
      var name = form.channelname.value.trim().replace(/\s+/g, '-').toLowerCase();
      if (!name) return;
      var ch = { id: uid('ch'), name: name, topic: form.topic.value.trim(), messages: [] };
      s.channels.push(ch);
      view.channelId = ch.id;
      save(); dlg.close(); render();
    };
  }

  function openSettings() {
    var dlg = document.getElementById('dlg-settings');
    var s = activeServer();
    if (!dlg || !s) return;

    function paint() {
      dlg.querySelector('#settings-name').value = s.name;
      dlg.querySelector('#role-list').innerHTML = s.roles.map(function (r) {
        return '<div class="role-row"><span style="display:flex;align-items:center;gap:8px">' +
               '<span class="swatch" style="background:' + esc(r.color) + '"></span>' + esc(r.name) + '</span>' +
               '<span style="display:flex;gap:8px;align-items:center">' +
               (r.perms.manage ? '<span class="role-chip">manage</span>' : '') +
               (r.perms.kick ? '<span class="role-chip">kick</span>' : '') +
               '<button type="button" class="btn btn-danger" data-del-role="' + r.id +
               '" style="min-height:36px;padding:4px 12px;font-size:13px">Delete</button></span></div>';
      }).join('');
    }
    paint();
    dlg.showModal();

    dlg.onclick = function (e) {
      var del = e.target.closest('[data-del-role]');
      if (del) {
        s.roles = s.roles.filter(function (r) { return r.id !== del.dataset.delRole; });
        save(); paint(); renderMembers();
      }
    };
    var form = dlg.querySelector('form');
    form.onsubmit = function (e) {
      e.preventDefault();
      s.name = dlg.querySelector('#settings-name').value.trim() || s.name;
      s.icon = initials(s.name);
      var newRole = dlg.querySelector('#new-role').value.trim();
      if (newRole) {
        s.roles.push({ id: uid('role'), name: newRole, color: dlg.querySelector('#new-role-color').value,
                       perms: { manage: dlg.querySelector('#perm-manage').checked,
                                kick: dlg.querySelector('#perm-kick').checked, post: true } });
        dlg.querySelector('#new-role').value = '';
      }
      save(); dlg.close(); render();
    };
  }

  // ---- Boot ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.dataset.page;
    if (page === 'auth') initAuth();
    else if (page === 'app') initApp();
    else if (page === 'home') {
      var cta = document.getElementById('cta-start');
      if (cta) cta.addEventListener('click', function () {
        location.href = currentUser() ? 'app.html' : 'auth.html#register';
      });
    }
  });
})();
`;
}
