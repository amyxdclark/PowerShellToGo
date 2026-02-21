/* ============================================================
   PowerShell To Go – app.js
   A client-side PowerShell interpreter with virtual filesystem
   ============================================================ */

'use strict';

// ── Constants ───────────────────────────────────────────────
const FS_KEY       = 'pstogo_fs';
const HIST_KEY     = 'pstogo_history';
const SETTINGS_KEY = 'pstogo_settings';
const APP_VERSION  = '1.0.0';

// ── State ───────────────────────────────────────────────────
const state = {
  cwd:          'C:\\Users\\PSUser\\Desktop',
  variables:    {},
  history:      [],
  historyIndex: -1,
  fontSize:     13,
  theme:        'dark',
  soundEnabled: false,
  suggestions:  [],
  sugIndex:     -1,
  pipeBuffer:   null,
};

// ── Virtual Filesystem ───────────────────────────────────────
// Structure: { path: { type:'dir'|'file', content?:string, created:date, modified:date } }
let vfs = {};

function initFS() {
  const saved = localStorage.getItem(FS_KEY);
  if (saved) {
    try { vfs = JSON.parse(saved); return; } catch(e) { /* fall through */ }
  }
  const now = new Date().toISOString();
  const dirs = [
    'C:',
    'C:\\Windows',
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\Users',
    'C:\\Users\\PSUser',
    'C:\\Users\\PSUser\\Desktop',
    'C:\\Users\\PSUser\\Documents',
    'C:\\Users\\PSUser\\Downloads',
    'C:\\Users\\PSUser\\Pictures',
    'C:\\Temp',
  ];
  dirs.forEach(d => { vfs[normPath(d)] = { type:'dir', created:now, modified:now }; });

  const files = {
    'C:\\Users\\PSUser\\Desktop\\readme.txt':
      'Welcome to PowerShell To Go!\r\nType Get-Help to see available commands.\r\nUse Tab for auto-completion.\r\nUse Up/Down arrows for command history.',
    'C:\\Users\\PSUser\\Documents\\notes.txt':
      'My PowerShell notes\r\n-------------------\r\nGet-ChildItem  - list directory contents\r\nSet-Location   - change directory\r\nGet-Content    - read a file\r\nSet-Content    - write to a file',
    'C:\\Users\\PSUser\\Desktop\\hello.ps1':
      'Write-Host "Hello from PowerShell To Go!" -ForegroundColor Cyan\r\nGet-Date',
    'C:\\Temp\\sample.json':
      '{\r\n  "name": "PowerShell To Go",\r\n  "version": "1.0",\r\n  "awesome": true\r\n}',
  };
  Object.entries(files).forEach(([p,c]) => {
    vfs[normPath(p)] = { type:'file', content:c, created:now, modified:now };
  });
  saveFS();
}

function saveFS() {
  try { localStorage.setItem(FS_KEY, JSON.stringify(vfs)); } catch(e) { /* quota */ }
}

function normPath(p) {
  if (!p) return '';
  // Normalize to consistent form: drive letter uppercase, backslashes, no trailing slash
  p = p.replace(/\//g, '\\').replace(/\\+/g, '\\');
  if (p.endsWith('\\') && p.length > 3) p = p.slice(0, -1);
  // Drive letter uppercase
  if (p.length >= 2 && p[1] === ':') p = p[0].toUpperCase() + p.slice(1);
  return p;
}

function resolvePath(p) {
  if (!p || p === '.') return normPath(state.cwd);
  p = p.trim();
  // Remove surrounding quotes
  p = p.replace(/^["']|["']$/g, '');
  // Absolute path
  if (/^[A-Za-z]:/.test(p)) return normPath(p);
  // Relative
  let base = state.cwd;
  const parts = p.split(/[/\\]/);
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      const idx = base.lastIndexOf('\\');
      if (idx > 2) base = base.slice(0, idx);
    } else {
      base = base + '\\' + part;
    }
  }
  return normPath(base);
}

function fsExists(p)    { return normPath(p) in vfs; }
function fsIsDir(p)     { return vfs[normPath(p)]?.type === 'dir'; }
function fsIsFile(p)    { return vfs[normPath(p)]?.type === 'file'; }
function fsGetContent(p){ return vfs[normPath(p)]?.content ?? ''; }

function fsListDir(dir) {
  dir = normPath(dir);
  const prefix = dir.endsWith('\\') ? dir : dir + '\\';
  return Object.keys(vfs)
    .filter(k => {
      if (!k.startsWith(prefix)) return false;
      const rest = k.slice(prefix.length);
      return rest.length > 0 && !rest.includes('\\');
    })
    .map(k => ({ path:k, name:k.slice(prefix.length), ...vfs[k] }));
}

function fsMkdir(p) {
  p = normPath(p);
  if (fsExists(p)) return false;
  const now = new Date().toISOString();
  vfs[p] = { type:'dir', created:now, modified:now };
  saveFS(); return true;
}

function fsWriteFile(p, content, append=false) {
  p = normPath(p);
  const now = new Date().toISOString();
  if (append && fsIsFile(p)) {
    vfs[p].content += content;
    vfs[p].modified = now;
  } else {
    vfs[p] = { type:'file', content: content ?? '', created: vfs[p]?.created ?? now, modified:now };
  }
  saveFS();
}

function fsDelete(p) {
  p = normPath(p);
  if (!fsExists(p)) return false;
  if (fsIsDir(p)) {
    // Remove children too
    const prefix = p + '\\';
    Object.keys(vfs).filter(k => k === p || k.startsWith(prefix)).forEach(k => delete vfs[k]);
  } else {
    delete vfs[p];
  }
  saveFS(); return true;
}

function fsCopy(src, dst) {
  src = normPath(src); dst = normPath(dst);
  if (!fsExists(src)) return false;
  const now = new Date().toISOString();
  if (fsIsDir(dst)) dst = dst + '\\' + src.split('\\').pop();
  if (fsIsFile(src)) {
    vfs[dst] = { ...vfs[src], modified:now };
    saveFS(); return true;
  }
  return false;
}

function fsMove(src, dst) {
  if (!fsCopy(src, dst)) return false;
  fsDelete(src); return true;
}

// ── Settings ────────────────────────────────────────────────
function loadSettings() {
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  state.theme    = s.theme    ?? 'dark';
  state.fontSize = s.fontSize ?? 13;
  applyTheme(state.theme);
  applyFontSize(state.fontSize);
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme:state.theme, fontSize:state.fontSize }));
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
  state.theme = theme;
  const toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.checked = (theme === 'light');
}

function applyFontSize(size) {
  state.fontSize = Math.max(10, Math.min(22, size));
  const output = document.getElementById('output');
  if (output) output.style.fontSize = state.fontSize + 'px';
  const sizeVal = document.getElementById('font-size-val');
  if (sizeVal) sizeVal.textContent = state.fontSize + 'px';
  const slider = document.getElementById('font-size-slider');
  if (slider) slider.value = state.fontSize;
}

// ── History ─────────────────────────────────────────────────
function loadHistory() {
  try { state.history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch(e) { state.history = []; }
}

function addHistory(cmd) {
  if (!cmd.trim()) return;
  state.history = state.history.filter(h => h !== cmd);
  state.history.push(cmd);
  if (state.history.length > 200) state.history.shift();
  state.historyIndex = state.history.length;
  localStorage.setItem(HIST_KEY, JSON.stringify(state.history));
}

// ── Output Helpers ───────────────────────────────────────────
const outputEl = () => document.getElementById('output');

function writeLine(text, cls='line-output', raw=false) {
  const out = outputEl();
  const span = document.createElement('span');
  span.className = 'line ' + cls;
  if (raw) span.innerHTML = text;
  else span.textContent = text;
  out.appendChild(span);
  out.appendChild(document.createTextNode('\n'));
  maybeScrollToBottom();
}

function writeLines(lines, cls='line-output') {
  lines.forEach(l => writeLine(l, cls));
}

function writeTable(rows, headers) {
  if (!rows || rows.length === 0) return;
  if (!headers) headers = Object.keys(rows[0]);
  const colWidths = headers.map(h => h.length);
  rows.forEach(r => headers.forEach((h,i) => {
    const v = String(r[h] ?? '');
    if (v.length > colWidths[i]) colWidths[i] = Math.min(v.length, 40);
  }));
  const out = outputEl();
  const table = document.createElement('table');
  table.className = 'ps-table';
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  headers.forEach((h,i) => {
    const th = document.createElement('th');
    th.textContent = h.padEnd(colWidths[i]);
    headerRow.appendChild(th);
  });
  // separator row via CSS border
  const tbody = table.createTBody();
  rows.forEach(r => {
    const tr = tbody.insertRow();
    headers.forEach(h => {
      const td = tr.insertCell();
      td.textContent = String(r[h] ?? '');
    });
  });
  out.appendChild(table);
  out.appendChild(document.createTextNode('\n'));
  maybeScrollToBottom();
}

function writeError(msg) { writeLine('ERROR: ' + msg, 'line-error'); }
function writeWarning(msg) { writeLine('WARNING: ' + msg, 'line-warning'); }
function writeSuccess(msg) { writeLine(msg, 'line-success'); }
function writeInfo(msg) { writeLine(msg, 'line-info'); }

function writePrompt(cmd) {
  const out = outputEl();
  const span = document.createElement('span');
  span.className = 'line line-prompt';
  span.innerHTML =
    `<span class="prompt-path">PS ${escHtml(state.cwd)}</span>` +
    `<span class="prompt-arrow"> &gt; </span>` +
    `<span class="ps-cmdlet">${escHtml(cmd)}</span>`;
  out.appendChild(span);
  out.appendChild(document.createTextNode('\n'));
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let autoScroll = true;
function maybeScrollToBottom() {
  const out = outputEl();
  if (autoScroll) out.scrollTop = out.scrollHeight;
  updateScrollBtn();
}

function scrollToBottom() {
  const out = outputEl();
  out.scrollTop = out.scrollHeight;
  autoScroll = true;
  updateScrollBtn();
}

function updateScrollBtn() {
  const out = outputEl();
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  autoScroll = atBottom;
  const btn = document.getElementById('scroll-btn');
  if (btn) btn.classList.toggle('visible', !atBottom);
}

// ── Variable expansion ───────────────────────────────────────
function expandVariables(str) {
  // Replace $varName and ${varName}
  return str
    .replace(/\$\{([^}]+)\}/g, (_,n) => state.variables[n] ?? '')
    .replace(/\$([A-Za-z_]\w*)/g, (_,n) => {
      const builtin = getBuiltinVar(n);
      return builtin !== undefined ? builtin : (state.variables[n] ?? ('$'+n));
    });
}

function getBuiltinVar(name) {
  const n = name.toLowerCase();
  if (n === 'null')  return '';
  if (n === 'true')  return 'True';
  if (n === 'false') return 'False';
  if (n === 'psversiontable') return 'Name:PSToGo Version:1.0';
  if (n === 'env:username' || n === 'username') return 'PSUser';
  if (n === 'env:computername' || n === 'computername') return 'PSTOGO-PC';
  if (n === 'home') return 'C:\\Users\\PSUser';
  if (n === 'pwd') return state.cwd;
  return undefined;
}

// ── Safe arithmetic evaluator (no eval / Function constructor) ──
function safeArith(expr) {
  // Tokenise: numbers, operators, parentheses, whitespace
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) { i++; continue; }
    if (/[\d.]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) num += expr[i++];
      tokens.push({ t:'num', v: parseFloat(num) });
    } else if ('+-*/%()'.includes(expr[i])) {
      tokens.push({ t:'op', v: expr[i++] });
    } else {
      return NaN; // unsupported token
    }
  }

  // Recursive descent parser
  let pos = 0;
  function peek()  { return tokens[pos]; }
  function consume(){ return tokens[pos++]; }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = consume().v;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = consume().v;
      const right = parseFactor();
      if (op === '*') left = left * right;
      else if (op === '/') left = right !== 0 ? left / right : NaN;
      else left = left % right;
    }
    return left;
  }
  function parseFactor() {
    const tok = peek();
    if (!tok) return NaN;
    if (tok.t === 'num') { consume(); return tok.v; }
    if (tok.v === '(') {
      consume();
      const val = parseExpr();
      if (peek() && peek().v === ')') consume();
      return val;
    }
    if (tok.v === '-') { consume(); return -parseFactor(); }
    if (tok.v === '+') { consume(); return  parseFactor(); }
    return NaN;
  }

  const result = parseExpr();
  return (pos === tokens.length && !isNaN(result)) ? result : NaN;
}

// ── Expression evaluator ─────────────────────────────────────
function evalExpression(expr) {
  expr = expandVariables(expr.trim());
  // Simple numeric arithmetic (safe recursive descent, no eval)
  if (/^[\d\s+\-*/%.()]+$/.test(expr)) {
    const n = safeArith(expr);
    if (!isNaN(n)) return String(n);
  }
  // String comparison
  const cmpMatch = expr.match(/^(.+?)\s*(-eq|-ne|-lt|-gt|-le|-ge|-like|-notlike|-match|-contains)\s*(.+)$/i);
  if (cmpMatch) {
    const [,l,op,r] = cmpMatch;
    const lv = l.trim().replace(/^["']|["']$/g,'');
    const rv = r.trim().replace(/^["']|["']$/g,'');
    switch(op.toLowerCase()) {
      case '-eq': return String(lv == rv);
      case '-ne': return String(lv != rv);
      case '-lt': return String(Number(lv) < Number(rv));
      case '-gt': return String(Number(lv) > Number(rv));
      case '-le': return String(Number(lv) <= Number(rv));
      case '-ge': return String(Number(lv) >= Number(rv));
      case '-like': return String(new RegExp('^' + rv.replace(/\*/g,'.*').replace(/\?/g,'.') + '$','i').test(lv));
      case '-notlike': return String(!new RegExp('^' + rv.replace(/\*/g,'.*').replace(/\?/g,'.') + '$','i').test(lv));
      case '-match': return String(new RegExp(rv,'i').test(lv));
      case '-contains': return String(lv.includes(rv));
    }
  }
  return expr;
}

// ── Token / Argument Parser ──────────────────────────────────
function parseArgs(str) {
  const args = [];
  let cur = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (c === ' ' && !inSingle && !inDouble) {
      if (cur) { args.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) args.push(cur);
  return args;
}

// Parse named parameters: -Name Value or -Name:Value or switch -Flag
function parseNamedParams(args) {
  const params = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith('-')) {
      const colonIdx = a.indexOf(':');
      let name, val;
      if (colonIdx > 0) {
        name = a.slice(1, colonIdx);
        val  = a.slice(colonIdx + 1);
      } else {
        name = a.slice(1);
        val  = (i+1 < args.length && !args[i+1].startsWith('-')) ? args[++i] : true;
      }
      params[name.toLowerCase()] = val;
    } else {
      positional.push(a);
    }
    i++;
  }
  return { params, positional };
}

// ── Pipeline parser ──────────────────────────────────────────
function parsePipeline(line) {
  // Split on | but not inside strings
  const segments = [];
  let cur = '';
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '|' && !inSingle && !inDouble) {
      segments.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  segments.push(cur.trim());
  return segments.filter(Boolean);
}

// ── Cmdlet implementations ───────────────────────────────────
const CMDLETS = {};

function reg(names, fn) {
  const list = Array.isArray(names) ? names : [names];
  list.forEach(n => CMDLETS[n.toLowerCase()] = fn);
}

// ─── Write-Output / Write-Host / echo ───────────────────────
reg(['Write-Output','Write-Host','echo'], (args, params, pipe) => {
  const input = pipe ?? args.join(' ');
  const text = expandVariables(input);
  writeLine(text);
  return text;
});

// ─── Write-Error ─────────────────────────────────────────────
reg('Write-Error', (args) => {
  writeError(expandVariables(args.join(' ')));
  return null;
});

// ─── Write-Warning ───────────────────────────────────────────
reg('Write-Warning', (args) => {
  writeWarning(expandVariables(args.join(' ')));
  return null;
});

// ─── Clear-Host / cls / clear ────────────────────────────────
reg(['Clear-Host','cls','clear'], () => {
  const out = outputEl();
  out.innerHTML = '';
  return null;
});

// ─── Get-Date ────────────────────────────────────────────────
reg('Get-Date', (args, params) => {
  const now = new Date();
  const fmt = params.format ?? params.uformat ?? null;
  let result;
  if (fmt) {
    result = fmt
      .replace('yyyy', now.getFullYear())
      .replace('MM', String(now.getMonth()+1).padStart(2,'0'))
      .replace('dd', String(now.getDate()).padStart(2,'0'))
      .replace('HH', String(now.getHours()).padStart(2,'0'))
      .replace('mm', String(now.getMinutes()).padStart(2,'0'))
      .replace('ss', String(now.getSeconds()).padStart(2,'0'));
  } else {
    result = now.toLocaleString('en-US', {
      weekday:'short', year:'numeric', month:'long', day:'numeric',
      hour:'2-digit', minute:'2-digit', second:'2-digit'
    });
  }
  writeLine(result);
  return result;
});

// ─── Get-Location / pwd ──────────────────────────────────────
reg(['Get-Location','pwd','gl'], (args, params, pipe) => {
  writeLine(state.cwd);
  return state.cwd;
});

// ─── Set-Location / cd ───────────────────────────────────────
reg(['Set-Location','cd','sl'], (args, params) => {
  let target = params.path ?? params.literalpath ?? args[0] ?? state.cwd;
  if (target === '~') target = 'C:\\Users\\PSUser';
  if (target === '-') target = state.cwd; // simple stub
  const resolved = resolvePath(target);
  if (!fsExists(resolved)) { writeError(`Cannot find path '${resolved}' because it does not exist.`); return null; }
  if (!fsIsDir(resolved))  { writeError(`'${resolved}' is not a directory.`); return null; }
  state.cwd = resolved;
  updatePromptLabel();
  return resolved;
});

// ─── Get-ChildItem / ls / dir / gci ──────────────────────────
reg(['Get-ChildItem','ls','dir','gci'], (args, params) => {
  const target = resolvePath(params.path ?? params.literalpath ?? args[0] ?? '.');
  if (!fsExists(target)) { writeError(`Cannot find path '${target}'.`); return null; }
  if (!fsIsDir(target))  { writeError(`'${target}' is not a directory.`); return null; }

  const items = fsListDir(target);
  if (items.length === 0) { writeLine('(empty directory)', 'line-muted'); return []; }

  // Group dirs then files
  const dirs  = items.filter(i => i.type === 'dir').sort((a,b) => a.name.localeCompare(b.name));
  const files = items.filter(i => i.type === 'file').sort((a,b) => a.name.localeCompare(b.name));

  writeLine('', 'line-muted');
  writeLine(`    Directory: ${target}`, 'line-header');
  writeLine('');
  writeLine('Mode                LastWriteTime         Length Name', 'line-header');
  writeLine('----                -------------         ------ ----', 'line-muted');

  const fmt = item => {
    const mode = item.type === 'dir' ? 'd----' : '-a---';
    const mod  = new Date(item.modified).toLocaleDateString('en-US', { month:'2-digit', day:'2-digit', year:'numeric' })
                 + ' ' + new Date(item.modified).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
    const len  = item.type === 'file' ? String(item.content?.length ?? 0).padStart(12) : '            ';
    writeLine(`${mode.padEnd(20)}${mod.padEnd(22)}${len}  ${item.name}`);
  };
  dirs.forEach(fmt); files.forEach(fmt);
  writeLine('');
  return [...dirs, ...files];
});

// ─── New-Item / mkdir / ni ────────────────────────────────────
reg(['New-Item','ni'], (args, params) => {
  const p    = resolvePath(params.path ?? args[0]);
  const type = (params.itemtype ?? params.type ?? 'file').toLowerCase();
  if (fsExists(p)) { writeError(`'${p}' already exists.`); return null; }
  if (type === 'directory' || type === 'dir') {
    fsMkdir(p);
    writeLine(`Created directory: ${p}`, 'line-success');
    return { path:p, type:'dir' };
  } else {
    const val = params.value ?? '';
    fsWriteFile(p, expandVariables(val));
    writeLine(`Created file: ${p}`, 'line-success');
    return { path:p, type:'file' };
  }
});

reg(['mkdir'], (args, params) => {
  const p = resolvePath(args[0]);
  if (fsExists(p)) { writeError(`'${p}' already exists.`); return null; }
  fsMkdir(p);
  writeLine(`Created directory: ${p}`, 'line-success');
  return { path:p, type:'dir' };
});

// ─── Remove-Item / rm / del ──────────────────────────────────
reg(['Remove-Item','rm','del','ri'], (args, params) => {
  const p = resolvePath(params.path ?? params.literalpath ?? args[0]);
  if (!fsExists(p)) { writeError(`Cannot find path '${p}'.`); return null; }
  const recurse = params.recurse === true || params.r === true;
  if (fsIsDir(p) && !recurse && fsListDir(p).length > 0) {
    writeError(`Directory '${p}' is not empty. Use -Recurse to remove all items.`); return null;
  }
  fsDelete(p);
  writeLine(`Removed: ${p}`, 'line-success');
  return null;
});

// ─── Get-Content / cat / type ────────────────────────────────
reg(['Get-Content','cat','type','gc'], (args, params) => {
  const p = resolvePath(params.path ?? params.literalpath ?? args[0]);
  if (!fsExists(p))  { writeError(`Cannot find path '${p}'.`); return null; }
  if (fsIsDir(p))    { writeError(`'${p}' is a directory.`); return null; }
  const content = fsGetContent(p);
  const tail = params.tail ? parseInt(params.tail) : null;
  const head = params.head ? parseInt(params.head) : null;
  let lines = content.split(/\r?\n/);
  if (tail) lines = lines.slice(-tail);
  if (head) lines = lines.slice(0, head);
  lines.forEach(l => writeLine(l));
  return content;
});

// ─── Set-Content / Add-Content ────────────────────────────────
reg(['Set-Content','sc'], (args, params) => {
  const p   = resolvePath(params.path ?? args[0]);
  const val = expandVariables(params.value ?? args.slice(1).join(' '));
  fsWriteFile(p, val, false);
  writeLine(`Written to: ${p}`, 'line-success');
  return null;
});

reg(['Add-Content','ac'], (args, params) => {
  const p   = resolvePath(params.path ?? args[0]);
  const val = '\r\n' + expandVariables(params.value ?? args.slice(1).join(' '));
  fsWriteFile(p, val, true);
  writeLine(`Appended to: ${p}`, 'line-success');
  return null;
});

// ─── Copy-Item / cp ──────────────────────────────────────────
reg(['Copy-Item','cp','cpi','copy'], (args, params) => {
  const src = resolvePath(params.path ?? args[0]);
  const dst = resolvePath(params.destination ?? args[1]);
  if (!fsCopy(src, dst)) { writeError(`Copy failed. Source '${src}' not found.`); return null; }
  writeLine(`Copied '${src}' to '${dst}'`, 'line-success');
  return null;
});

// ─── Move-Item / mv ──────────────────────────────────────────
reg(['Move-Item','mv','mi','move'], (args, params) => {
  const src = resolvePath(params.path ?? args[0]);
  const dst = resolvePath(params.destination ?? args[1]);
  if (!fsMove(src, dst)) { writeError(`Move failed. Source '${src}' not found.`); return null; }
  writeLine(`Moved '${src}' to '${dst}'`, 'line-success');
  return null;
});

// ─── Rename-Item / ren ───────────────────────────────────────
reg(['Rename-Item','ren','rni'], (args, params) => {
  const src     = resolvePath(params.path ?? args[0]);
  const newName = params.newname ?? args[1];
  if (!newName) { writeError('NewName parameter is required.'); return null; }
  const parentDir = src.slice(0, src.lastIndexOf('\\'));
  const dst = normPath(parentDir + '\\' + newName);
  if (!fsMove(src, dst)) { writeError(`Rename failed. '${src}' not found.`); return null; }
  writeLine(`Renamed to: ${dst}`, 'line-success');
  return null;
});

// ─── Test-Path ───────────────────────────────────────────────
reg('Test-Path', (args, params) => {
  const p = resolvePath(params.path ?? args[0]);
  const result = fsExists(p);
  writeLine(result ? 'True' : 'False');
  return result;
});

// ─── Get-Variable / $var ─────────────────────────────────────
reg(['Get-Variable','gv'], (args, params) => {
  const name = params.name ?? args[0];
  if (name) {
    const val = state.variables[name];
    if (val === undefined) { writeError(`Variable '${name}' not found.`); return null; }
    writeLine(`${name}: ${val}`);
    return val;
  }
  // List all
  const rows = Object.entries(state.variables).map(([n,v]) => ({ Name:n, Value:String(v) }));
  if (rows.length === 0) writeLine('(no user variables)', 'line-muted');
  else writeTable(rows, ['Name','Value']);
  return rows;
});

// ─── Set-Variable / sv ───────────────────────────────────────
reg(['Set-Variable','sv'], (args, params) => {
  const name  = params.name  ?? args[0];
  const value = expandVariables(params.value ?? args[1] ?? '');
  if (!name) { writeError('Name is required.'); return null; }
  state.variables[name] = value;
  return value;
});

// ─── Remove-Variable / rv ────────────────────────────────────
reg(['Remove-Variable','rv'], (args, params) => {
  const name = params.name ?? args[0];
  if (!name) { writeError('Name is required.'); return null; }
  if (!(name in state.variables)) { writeError(`Variable '${name}' not found.`); return null; }
  delete state.variables[name];
  writeLine(`Removed variable: ${name}`, 'line-success');
  return null;
});

// ─── Select-Object ───────────────────────────────────────────
reg(['Select-Object','select'], (args, params, pipe) => {
  const propArg = params.property ?? args[0];
  const first   = params.first ? parseInt(params.first) : null;
  const last    = params.last  ? parseInt(params.last)  : null;
  let data = pipe;
  if (!data) { writeError('Select-Object requires piped input.'); return null; }
  if (!Array.isArray(data)) data = [data];
  if (first) data = data.slice(0, first);
  if (last)  data = data.slice(-last);
  if (propArg) {
    const props = propArg.split(',').map(p => p.trim());
    data = data.map(item => {
      if (typeof item !== 'object') return item;
      const out = {};
      props.forEach(p => { if (p in item) out[p] = item[p]; });
      return out;
    });
  }
  data.forEach(item => {
    if (typeof item === 'object') writeTable([item], Object.keys(item));
    else writeLine(String(item));
  });
  return data;
});

// ─── Where-Object / ? ────────────────────────────────────────
reg(['Where-Object','where','?'], (args, params, pipe) => {
  if (!pipe) { writeError('Where-Object requires piped input.'); return null; }
  const expr = args.join(' ').replace(/^\{|\}$/g,'').trim();
  let data = Array.isArray(pipe) ? pipe : [pipe];
  const result = data.filter(item => {
    // Simple property comparisons: $_.Name -eq "foo"
    const expanded = expr.replace(/\$_\.?(\w+)/g, (_,p) =>
      typeof item === 'object' ? String(item[p] ?? '') : String(item)
    ).replace(/\$_/g, String(item));
    return evalExpression(expanded).toLowerCase() === 'true';
  });
  result.forEach(item => {
    if (typeof item === 'object') writeTable([item]);
    else writeLine(String(item));
  });
  return result;
});

// ─── ForEach-Object / % ──────────────────────────────────────
reg(['ForEach-Object','foreach','%'], (args, params, pipe) => {
  if (!pipe) { writeError('ForEach-Object requires piped input.'); return null; }
  let data = Array.isArray(pipe) ? pipe : [pipe];
  const script = args.join(' ').replace(/^\{|\}$/g,'').trim();
  const results = data.map(item => {
    // Set $_ and run
    state.variables['_'] = typeof item === 'object' ? JSON.stringify(item) : String(item);
    const expanded = script.replace(/\$_\.?(\w+)/g, (_,p) =>
      typeof item === 'object' ? String(item[p] ?? '') : String(item)
    ).replace(/\$_/g, String(item));
    const result = executeCommand(expandVariables(expanded));
    return result;
  });
  return results;
});

// ─── Sort-Object ─────────────────────────────────────────────
reg(['Sort-Object','sort'], (args, params, pipe) => {
  if (!pipe) { writeError('Sort-Object requires piped input.'); return null; }
  let data = Array.isArray(pipe) ? [...pipe] : [pipe];
  const prop = params.property ?? args[0];
  const desc = params.descending === true || params.desc === true;
  data.sort((a,b) => {
    const av = prop && typeof a === 'object' ? String(a[prop] ?? '') : String(a);
    const bv = prop && typeof b === 'object' ? String(b[prop] ?? '') : String(b);
    const n = isNaN(av) || isNaN(bv) ? av.localeCompare(bv) : Number(av) - Number(bv);
    return desc ? -n : n;
  });
  data.forEach(item => {
    if (typeof item === 'object') writeTable([item]);
    else writeLine(String(item));
  });
  return data;
});

// ─── Measure-Object ──────────────────────────────────────────
reg(['Measure-Object','measure'], (args, params, pipe) => {
  if (!pipe) { writeError('Measure-Object requires piped input.'); return null; }
  let data = Array.isArray(pipe) ? pipe : [pipe];
  const prop = params.property ?? args[0];
  const sum = params.sum === true, avg = params.average === true,
        min = params.minimum === true, max = params.maximum === true,
        all = (!sum && !avg && !min && !max);
  const nums = data.map(item => {
    const v = prop && typeof item === 'object' ? item[prop] : item;
    return Number(v);
  }).filter(n => !isNaN(n));

  const result = { Count: data.length };
  if (sum || all) result.Sum = nums.reduce((a,b)=>a+b,0);
  if (avg || all) result.Average = nums.length ? (result.Sum ?? nums.reduce((a,b)=>a+b,0)) / nums.length : null;
  if (min || all) result.Minimum = nums.length ? Math.min(...nums) : null;
  if (max || all) result.Maximum = nums.length ? Math.max(...nums) : null;
  writeTable([result]);
  return result;
});

// ─── Format-List / fl ────────────────────────────────────────
reg(['Format-List','fl'], (args, params, pipe) => {
  let data = pipe ?? args;
  if (!Array.isArray(data)) data = [data];
  data.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      Object.entries(item).forEach(([k,v]) => writeLine(`${k.padEnd(20)}: ${v}`));
    } else {
      writeLine(String(item));
    }
    writeLine('');
  });
  return data;
});

// ─── Format-Table / ft ───────────────────────────────────────
reg(['Format-Table','ft'], (args, params, pipe) => {
  let data = pipe ?? args;
  if (!Array.isArray(data)) data = data ? [data] : [];
  if (data.length === 0) { writeLine('(empty)', 'line-muted'); return null; }
  const headers = typeof data[0] === 'object' ? Object.keys(data[0]) : ['Value'];
  const rows = data.map(item => typeof item === 'object' ? item : { Value: item });
  writeTable(rows, headers);
  return data;
});

// ─── Out-String ──────────────────────────────────────────────
reg('Out-String', (args, params, pipe) => {
  const s = Array.isArray(pipe) ? pipe.map(String).join('\n') : String(pipe ?? '');
  writeLine(s);
  return s;
});

// ─── ConvertTo-Json ──────────────────────────────────────────
reg(['ConvertTo-Json','ctj'], (args, params, pipe) => {
  const input = pipe ?? args.join(' ');
  try {
    const depth = parseInt(params.depth ?? 2);
    const json = JSON.stringify(input, null, 2);
    writeLine(json);
    return json;
  } catch(e) {
    writeError('ConvertTo-Json: ' + e.message); return null;
  }
});

// ─── ConvertFrom-Json ────────────────────────────────────────
reg(['ConvertFrom-Json','cfj'], (args, params, pipe) => {
  const input = pipe ?? args.join(' ');
  try {
    const obj = JSON.parse(expandVariables(String(input)));
    writeTable(Array.isArray(obj) ? obj : [obj]);
    return obj;
  } catch(e) {
    writeError('ConvertFrom-Json: Invalid JSON. ' + e.message); return null;
  }
});

// ─── Get-Process (simulated) ─────────────────────────────────
reg(['Get-Process','ps','gps'], (args, params) => {
  const processes = [
    { Name:'pwsh',       Id:1,    CPU:0.1,  WorkingSet:'64 MB',  Status:'Running' },
    { Name:'node',       Id:42,   CPU:1.2,  WorkingSet:'128 MB', Status:'Running' },
    { Name:'chrome',     Id:101,  CPU:8.5,  WorkingSet:'512 MB', Status:'Running' },
    { Name:'code',       Id:202,  CPU:2.1,  WorkingSet:'256 MB', Status:'Running' },
    { Name:'explorer',   Id:300,  CPU:0.0,  WorkingSet:'48 MB',  Status:'Running' },
    { Name:'svchost',    Id:401,  CPU:0.3,  WorkingSet:'32 MB',  Status:'Running' },
    { Name:'system',     Id:4,    CPU:0.0,  WorkingSet:'8 MB',   Status:'Running' },
    { Name:'pstogo-app', Id:999,  CPU:0.5,  WorkingSet:'32 MB',  Status:'Running' },
  ];
  const filter = args[0]?.replace(/\*/g,'');
  const rows = filter ? processes.filter(p => p.Name.includes(filter)) : processes;
  if (rows.length === 0) { writeLine('(no matching processes)', 'line-muted'); return null; }
  writeTable(rows, ['Name','Id','CPU','WorkingSet','Status']);
  return rows;
});

// ─── Get-History ─────────────────────────────────────────────
reg(['Get-History','h','history'], (args, params) => {
  const count = parseInt(params.count ?? args[0] ?? state.history.length);
  const hist = state.history.slice(-count).map((cmd,i) => ({
    Id: state.history.length - count + i + 1,
    CommandLine: cmd
  }));
  if (hist.length === 0) { writeLine('(no history)', 'line-muted'); return []; }
  writeTable(hist, ['Id','CommandLine']);
  return hist;
});

// ─── Invoke-Expression / iex ─────────────────────────────────
reg(['Invoke-Expression','iex'], (args, params, pipe) => {
  const script = expandVariables(pipe ?? params.command ?? args.join(' '));
  return executeCommand(script);
});

// ─── Get-Command / gcm ───────────────────────────────────────
reg(['Get-Command','gcm'], (args, params) => {
  const filter = (args[0] ?? '').toLowerCase().replace(/\*/g,'');
  const all = Object.keys(CMDLETS)
    .filter((k,i,a) => a.indexOf(k) === i) // unique keys (some are aliases)
    .filter(k => !filter || k.includes(filter))
    .sort();

  // Group by verb
  const rows = all.map(k => ({
    CommandType: 'Cmdlet',
    Name: k,
    Module: 'PSToGo'
  }));
  writeTable(rows, ['CommandType','Name','Module']);
  return rows;
});

// ─── Get-Help ────────────────────────────────────────────────
reg(['Get-Help','help','man'], (args, params) => {
  const topic = args[0]?.toLowerCase();

  if (!topic) {
    writeLine('');
    writeLine('POWERSHELL TO GO – Built-in Help', 'line-header');
    writeLine('─'.repeat(50), 'line-muted');
    writeLine('');
    writeLine('NAVIGATION', 'line-info');
    writeLine('  Set-Location (cd)    Change directory');
    writeLine('  Get-Location (pwd)   Show current path');
    writeLine('  Get-ChildItem (ls)   List directory contents');
    writeLine('');
    writeLine('FILE OPERATIONS', 'line-info');
    writeLine('  Get-Content (cat)    Read a file');
    writeLine('  Set-Content (sc)     Write to a file');
    writeLine('  Add-Content (ac)     Append to a file');
    writeLine('  New-Item (ni)        Create file or directory');
    writeLine('  Remove-Item (rm)     Delete file or directory (-Recurse for dirs)');
    writeLine('  Copy-Item (cp)       Copy a file');
    writeLine('  Move-Item (mv)       Move a file');
    writeLine('  Rename-Item (ren)    Rename a file');
    writeLine('  Test-Path            Check if path exists');
    writeLine('');
    writeLine('OUTPUT', 'line-info');
    writeLine('  Write-Output (echo)  Output text');
    writeLine('  Write-Host           Output with color support');
    writeLine('  Write-Error          Output an error');
    writeLine('  Write-Warning        Output a warning');
    writeLine('  Clear-Host (cls)     Clear the screen');
    writeLine('');
    writeLine('DATA', 'line-info');
    writeLine('  Get-Variable (gv)    View variables');
    writeLine('  Set-Variable (sv)    Set a variable');
    writeLine('  Remove-Variable      Remove a variable');
    writeLine('  Select-Object        Select properties');
    writeLine('  Where-Object         Filter objects');
    writeLine('  ForEach-Object       Iterate objects');
    writeLine('  Sort-Object          Sort objects');
    writeLine('  Measure-Object       Calculate statistics');
    writeLine('  Format-Table (ft)    Format as table');
    writeLine('  Format-List (fl)     Format as list');
    writeLine('  ConvertTo-Json       Convert to JSON');
    writeLine('  ConvertFrom-Json     Parse JSON');
    writeLine('');
    writeLine('SYSTEM', 'line-info');
    writeLine('  Get-Date             Current date/time');
    writeLine('  Get-Process (ps)     Running processes');
    writeLine('  Get-History          Command history');
    writeLine('  Get-Command (gcm)    List all commands');
    writeLine('  Invoke-Expression    Execute a string as a command');
    writeLine('  Out-String           Convert to string');
    writeLine('');
    writeLine('TIPS', 'line-info');
    writeLine('  • Use Tab for auto-completion');
    writeLine('  • Use ↑/↓ for command history');
    writeLine('  • Use | to pipe commands');
    writeLine('  • Variables: $name = "value"  (use Set-Variable)');
    writeLine('  • Type "Get-Help <command>" for specific help');
    writeLine('');
    return null;
  }

  // Specific command help
  const helps = {
    'get-childitem': ['Get-ChildItem [-Path <path>]','Lists items in a directory.','  ls C:\\Users\\PSUser','  gci -Path C:\\Temp'],
    'set-location': ['Set-Location [-Path] <path>','Changes the current directory.','  cd Documents','  Set-Location C:\\Temp'],
    'get-content': ['Get-Content [-Path] <path> [-Head n] [-Tail n]','Reads the content of a file.','  cat readme.txt','  gc -Tail 5 notes.txt'],
    'set-content': ['Set-Content [-Path] <path> [-Value] <text>','Writes text to a file.','  sc file.txt "Hello"'],
    'new-item': ['New-Item [-Path] <path> [-ItemType file|directory] [-Value <text>]','Creates a new file or directory.','  ni test.txt','  ni -ItemType Directory myfolder'],
    'remove-item': ['Remove-Item [-Path] <path> [-Recurse]','Deletes a file or directory.','  rm test.txt','  Remove-Item myfolder -Recurse'],
    'where-object': ['... | Where-Object { $_.Property -op value }','Filters objects from the pipeline.','  ls | Where-Object { $_.type -eq "file" }'],
    'foreach-object': ['... | ForEach-Object { commands }','Runs commands for each pipeline item.','  1,2,3 | ForEach-Object { Write-Output $_ }'],
    'measure-object': ['... | Measure-Object [-Property name] [-Sum] [-Average] [-Min] [-Max]','Calculates numeric statistics.','  Get-Process | Measure-Object -Property CPU -Sum'],
  };

  const h = helps[topic] ?? helps['get-'+topic];
  if (h) {
    writeLine('');
    writeLine('SYNTAX', 'line-info');
    writeLine('  ' + h[0]);
    writeLine('');
    writeLine('DESCRIPTION', 'line-info');
    writeLine('  ' + h[1]);
    writeLine('');
    writeLine('EXAMPLES', 'line-info');
    h.slice(2).forEach(ex => writeLine('  ' + ex));
    writeLine('');
  } else {
    writeLine(`No specific help available for '${args[0]}'. Try: Get-Help`, 'line-warning');
  }
  return null;
});

// ─── Resolve-Path ─────────────────────────────────────────────
reg('Resolve-Path', (args, params) => {
  const p = resolvePath(params.path ?? args[0]);
  if (!fsExists(p)) { writeError(`Cannot find path '${p}'.`); return null; }
  writeLine(p);
  return p;
});

// ─── Split-Path ───────────────────────────────────────────────
reg('Split-Path', (args, params) => {
  const p = resolvePath(params.path ?? args[0]);
  const leaf = params.leaf === true;
  const parent = params.parent === true || !leaf;
  const result = leaf ? p.split('\\').pop() : p.slice(0, p.lastIndexOf('\\'));
  writeLine(result);
  return result;
});

// ─── Join-Path ────────────────────────────────────────────────
reg('Join-Path', (args, params) => {
  const base = params.path ?? args[0] ?? state.cwd;
  const child = params.childpath ?? args[1] ?? '';
  const result = normPath(base + '\\' + child);
  writeLine(result);
  return result;
});

// ─── Get-Item ─────────────────────────────────────────────────
reg(['Get-Item','gi'], (args, params) => {
  const p = resolvePath(params.path ?? args[0]);
  if (!fsExists(p)) { writeError(`Cannot find path '${p}'.`); return null; }
  const item = vfs[normPath(p)];
  const info = {
    FullName: p,
    Name: p.split('\\').pop(),
    Type: item.type,
    Length: item.type === 'file' ? (item.content?.length ?? 0) : '-',
    LastWriteTime: new Date(item.modified).toLocaleString(),
    CreationTime:  new Date(item.created).toLocaleString(),
  };
  writeTable([info]);
  return info;
});

// ─── Start-Sleep ──────────────────────────────────────────────
reg('Start-Sleep', (args, params) => {
  const secs = parseFloat(params.seconds ?? params.s ?? args[0] ?? 1);
  writeLine(`Sleeping ${secs}s...`, 'line-muted');
  // Not actually async; just note it
  return null;
});

// ─── $var = value assignment ──────────────────────────────────
// Handled in executeCommand for $var = expr pattern

// ─── Write-Progress (stub) ────────────────────────────────────
reg('Write-Progress', (args, params) => {
  writeLine(`[Progress] ${params.activity ?? args[0] ?? ''}`, 'line-info');
  return null;
});

// ─── Get-Random ───────────────────────────────────────────────
reg('Get-Random', (args, params) => {
  const max = parseInt(params.maximum ?? params.max ?? args[0] ?? 100);
  const min = parseInt(params.minimum ?? params.min ?? 0);
  const r = Math.floor(Math.random() * (max - min)) + min;
  writeLine(String(r));
  return r;
});

// ─── String cmdlets ───────────────────────────────────────────
reg('Get-Member', (args, params, pipe) => {
  const methods = ['Contains','EndsWith','IndexOf','Insert','Length','PadLeft','PadRight',
                   'Remove','Replace','Split','StartsWith','Substring','ToLower','ToUpper','Trim'];
  writeLine('String Members:', 'line-header');
  methods.forEach(m => writeLine(`  .${m}()`, 'line-info'));
  return null;
});

reg(['Format-String','format'], (args, params) => {
  const fmt  = params.format ?? args[0];
  const vals = args.slice(1);
  if (!fmt) { writeError('Format parameter required.'); return null; }
  const result = fmt.replace(/\{(\d+)\}/g, (_,i) => vals[i] ?? '');
  writeLine(result);
  return result;
});

// ─── cd aliases convenience ───────────────────────────────────
reg('..', () => { return CMDLETS['set-location'](['..'], {}, null); });
reg('~',  () => { return CMDLETS['set-location'](['~'], {}, null); });

// ── Command Executor ─────────────────────────────────────────
function executeCommand(line) {
  if (!line || !line.trim()) return null;
  line = line.trim();

  // Skip comments
  if (line.startsWith('#')) return null;

  // Variable assignment: $name = expr
  const assignMatch = line.match(/^\$([A-Za-z_]\w*)\s*=\s*(.*)$/);
  if (assignMatch) {
    const [, name, expr] = assignMatch;
    const value = evalExpression(expandVariables(expr.trim().replace(/^["']|["']$/g,'')));
    state.variables[name] = value;
    return value;
  }

  // Arithmetic expression only (no cmdlet prefix)
  if (/^[\d(]/.test(line) && /^[\d\s+\-*/%.()]+$/.test(line)) {
    const n = safeArith(line);
    if (!isNaN(n)) { writeLine(String(n)); return n; }
  }

  // Pipeline
  const segments = parsePipeline(line);
  let pipeValue = null;

  for (let si = 0; si < segments.length; si++) {
    const seg = expandVariables(segments[si]).trim();
    if (!seg) continue;

    const rawArgs  = parseArgs(seg);
    if (!rawArgs.length) continue;

    const cmdName  = rawArgs[0].toLowerCase();
    const restArgs = rawArgs.slice(1);
    const { params, positional } = parseNamedParams(restArgs);
    const allArgs  = positional;

    const fn = CMDLETS[cmdName];
    if (!fn) {
      // Attempt to run as expression/alias
      if (cmdName.startsWith('$')) {
        const varName = cmdName.slice(1);
        const val = state.variables[varName] ?? getBuiltinVar(varName);
        if (val !== undefined) { writeLine(String(val)); pipeValue = val; continue; }
      }
      writeError(`The term '${rawArgs[0]}' is not recognized as a cmdlet, function, or operable program.`);
      writeError(`Type 'Get-Help' for a list of available commands.`);
      pipeValue = null; break;
    }

    pipeValue = fn(allArgs, params, pipeValue);
  }

  return pipeValue;
}

// ── Tab completion ────────────────────────────────────────────
const ALL_CMDLETS_SORTED = () => Object.keys(CMDLETS).sort();

function getCompletions(input) {
  input = input.trimStart();
  const tokens = parseArgs(input);
  if (tokens.length === 0) return [];

  const firstToken = tokens[0];
  const isFirstToken = tokens.length === 1 && !input.endsWith(' ');

  if (isFirstToken) {
    // Complete cmdlet name
    const lower = firstToken.toLowerCase();
    return ALL_CMDLETS_SORTED()
      .filter(k => k.startsWith(lower))
      .slice(0, 12)
      .map(k => ({ label: k, type:'cmdlet', replace: k }));
  }

  // Complete file path (last token)
  const lastToken = tokens[tokens.length - 1];
  const colonIdx = lastToken.lastIndexOf(':');
  const isAbsolute = /^[A-Za-z]:/.test(lastToken);
  const slashIdx = Math.max(lastToken.lastIndexOf('\\'), lastToken.lastIndexOf('/'));

  let dir, prefix;
  if (slashIdx >= 0 || isAbsolute) {
    let base = lastToken.slice(0, slashIdx + 1);
    prefix = lastToken.slice(slashIdx + 1);
    dir = isAbsolute ? resolvePath(base || lastToken.slice(0,2)+'\\') : resolvePath(base || '.');
  } else {
    dir = state.cwd;
    prefix = lastToken;
  }

  const items = fsExists(dir) ? fsListDir(dir) : [];
  return items
    .filter(i => i.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .slice(0, 12)
    .map(i => ({
      label: i.name + (i.type==='dir'?'\\':''),
      type: i.type,
      replace: (slashIdx >= 0 ? lastToken.slice(0, slashIdx+1) : '') + i.name + (i.type==='dir'?'\\':'')
    }));
}

// ── DOM / UI ──────────────────────────────────────────────────
let installPromptEvent = null;

function updatePromptLabel() {
  const el = document.getElementById('input-prompt-label');
  if (el) el.textContent = 'PS ' + state.cwd + ' >';
}

function showSuggestions(items) {
  const box = document.getElementById('suggestions');
  if (!items.length) { hideSuggestions(); return; }
  box.innerHTML = '';
  items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.textContent = item.label;
    const typeSpan = document.createElement('span');
    typeSpan.className = 'sug-type';
    typeSpan.textContent = item.type;
    div.appendChild(typeSpan);
    div.addEventListener('pointerdown', e => {
      e.preventDefault();
      applyCompletion(item);
      hideSuggestions();
    });
    box.appendChild(div);
  });
  state.suggestions = items;
  state.sugIndex = -1;
  box.classList.add('visible');
}

function hideSuggestions() {
  document.getElementById('suggestions').classList.remove('visible');
  state.suggestions = [];
  state.sugIndex = -1;
}

function applyCompletion(item) {
  const input = document.getElementById('cmd-input');
  const val   = input.value;
  const tokens = parseArgs(val);
  if (tokens.length <= 1 && !val.endsWith(' ')) {
    input.value = item.replace;
  } else {
    // Replace last token
    const lastSpace = val.lastIndexOf(' ');
    input.value = (lastSpace >= 0 ? val.slice(0, lastSpace+1) : '') + item.replace;
  }
  input.focus();
  // move cursor to end
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function runInput() {
  const input = document.getElementById('cmd-input');
  const cmd   = input.value.trim();
  hideSuggestions();
  if (!cmd) return;

  writePrompt(cmd);
  addHistory(cmd);
  state.historyIndex = state.history.length;
  input.value = '';

  // Multiple commands separated by semicolons
  const cmds = splitStatements(cmd);
  cmds.forEach(c => executeCommand(c));

  scrollToBottom();
  setTimeout(() => input.focus(), 50);
}

// Split on ; but not inside strings or script blocks
function splitStatements(line) {
  const stmts = [];
  let cur = '';
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '{' && !inS && !inD) depth++;
    else if (c === '}' && !inS && !inD) depth--;
    else if (c === ';' && !inS && !inD && depth === 0) {
      stmts.push(cur.trim()); cur = ''; continue;
    }
    cur += c;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts.filter(Boolean);
}

function initUI() {
  const input  = document.getElementById('cmd-input');
  const runBtn = document.getElementById('run-btn');

  // Enter to run
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.sugIndex >= 0 && state.suggestions.length) {
        applyCompletion(state.suggestions[state.sugIndex]);
        hideSuggestions();
        return;
      }
      runInput();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const comps = getCompletions(input.value);
      if (comps.length === 1) {
        applyCompletion(comps[0]);
        hideSuggestions();
      } else if (comps.length > 1) {
        if (state.suggestions.length === 0) {
          showSuggestions(comps);
        } else {
          state.sugIndex = (state.sugIndex + 1) % state.suggestions.length;
          document.querySelectorAll('.suggestion-item').forEach((el,i) =>
            el.classList.toggle('selected', i === state.sugIndex));
          if (state.sugIndex >= 0) applyCompletion(state.suggestions[state.sugIndex]);
        }
      }
      return;
    }

    if (e.key === 'Escape') { hideSuggestions(); return; }

    if (e.key === 'ArrowUp') {
      if (state.suggestions.length) {
        e.preventDefault();
        state.sugIndex = Math.max(0, state.sugIndex - 1);
        document.querySelectorAll('.suggestion-item').forEach((el,i) =>
          el.classList.toggle('selected', i === state.sugIndex));
        if (state.sugIndex >= 0) applyCompletion(state.suggestions[state.sugIndex]);
        return;
      }
      e.preventDefault();
      if (state.historyIndex > 0) {
        state.historyIndex--;
        input.value = state.history[state.historyIndex] ?? '';
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      if (state.suggestions.length) {
        e.preventDefault();
        state.sugIndex = Math.min(state.suggestions.length - 1, state.sugIndex + 1);
        document.querySelectorAll('.suggestion-item').forEach((el,i) =>
          el.classList.toggle('selected', i === state.sugIndex));
        if (state.sugIndex >= 0) applyCompletion(state.suggestions[state.sugIndex]);
        return;
      }
      e.preventDefault();
      if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        input.value = state.history[state.historyIndex] ?? '';
      } else {
        state.historyIndex = state.history.length;
        input.value = '';
      }
      return;
    }

    // Hide suggestions on regular keypress
    if (!['Shift','Control','Alt','Meta'].includes(e.key)) hideSuggestions();
  });

  // Live tab suggestion on input
  input.addEventListener('input', () => {
    if (input.value.length > 1) {
      const comps = getCompletions(input.value);
      if (comps.length > 1) showSuggestions(comps);
      else hideSuggestions();
    } else {
      hideSuggestions();
    }
  });

  runBtn.addEventListener('click', runInput);

  // Scroll tracking
  const out = document.getElementById('output');
  out.addEventListener('scroll', updateScrollBtn, { passive:true });

  document.getElementById('scroll-btn').addEventListener('click', scrollToBottom);

  // Toolbar buttons
  document.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd) {
        input.value = cmd;
        if (btn.dataset.run === 'true') {
          runInput();
        } else {
          input.focus();
        }
      }
    });
  });

  // Header icon buttons
  document.getElementById('btn-settings')?.addEventListener('click', openSettings);
  document.getElementById('btn-help')?.addEventListener('click', openHelp);
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    executeCommand('Clear-Host');
  });

  // Settings panel
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });

  document.getElementById('theme-toggle')?.addEventListener('change', e => {
    applyTheme(e.target.checked ? 'light' : 'dark');
    saveSettings();
  });

  document.getElementById('font-size-slider')?.addEventListener('input', e => {
    applyFontSize(parseInt(e.target.value));
    saveSettings();
  });

  document.getElementById('btn-clear-history')?.addEventListener('click', () => {
    state.history = [];
    localStorage.removeItem(HIST_KEY);
    writeLine('Command history cleared.', 'line-success');
    closeSettings();
  });

  document.getElementById('btn-reset-fs')?.addEventListener('click', () => {
    if (confirm('Reset the virtual filesystem to defaults? This cannot be undone.')) {
      localStorage.removeItem(FS_KEY);
      vfs = {};
      initFS();
      state.cwd = 'C:\\Users\\PSUser\\Desktop';
      updatePromptLabel();
      writeLine('Filesystem reset to defaults.', 'line-success');
      closeSettings();
    }
  });

  document.getElementById('btn-export')?.addEventListener('click', () => {
    const data = JSON.stringify({ vfs, history: state.history, variables: state.variables }, null, 2);
    const blob = new Blob([data], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'pstogo-export.json';
    a.click(); URL.revokeObjectURL(url);
    closeSettings();
  });

  // Help panel
  document.getElementById('help-close')?.addEventListener('click', closeHelp);
  document.getElementById('help-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('help-overlay')) closeHelp();
  });

  // Install banner
  document.getElementById('install-btn')?.addEventListener('click', () => {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      installPromptEvent.userChoice.then(() => {
        installPromptEvent = null;
        hideBanner();
      });
    }
  });
  document.getElementById('install-dismiss')?.addEventListener('click', hideBanner);

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPromptEvent = e;
    document.getElementById('install-banner')?.classList.add('visible');
  });

  window.addEventListener('appinstalled', () => {
    installPromptEvent = null;
    hideBanner();
    writeLine('✓ PowerShell To Go installed as a PWA!', 'line-success');
  });

  // Keep terminal visible when virtual keyboard appears on mobile
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', () => {
      document.getElementById('app').style.height = window.visualViewport.height + 'px';
    });
  }

  // Focus input on tap anywhere in output
  out.addEventListener('click', () => {
    const sel = window.getSelection();
    if (!sel || sel.toString().length === 0) input.focus();
  });
}

function openSettings() {
  document.getElementById('settings-overlay')?.classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-overlay')?.classList.remove('open');
}
function openHelp() {
  document.getElementById('help-overlay')?.classList.add('open');
}
function closeHelp() {
  document.getElementById('help-overlay')?.classList.remove('open');
}
function hideBanner() {
  document.getElementById('install-banner')?.classList.remove('visible');
}

// ── Welcome message ───────────────────────────────────────────
function showWelcome() {
  const out = outputEl();
  const div = document.createElement('div');
  div.id = 'welcome';
  div.innerHTML = `
    <strong>⚡ PowerShell To Go v${APP_VERSION}</strong><br>
    <span>Copyright &copy; ${new Date().getFullYear()} &ndash; Running in your browser</span><br><br>
    Type <span class="ps-cmdlet">Get-Help</span> for available commands, or
    <span class="ps-cmdlet">Get-ChildItem</span> to explore the filesystem.<br>
    Press <kbd style="background:var(--bg-button);padding:1px 5px;border-radius:3px;font-size:11px;">Tab</kbd> for auto-complete &nbsp;|&nbsp;
    <kbd style="background:var(--bg-button);padding:1px 5px;border-radius:3px;font-size:11px;">↑↓</kbd> for history
  `;
  out.appendChild(div);
}

// ── Main init ─────────────────────────────────────────────────
function init() {
  initFS();
  loadSettings();
  loadHistory();
  initUI();
  updatePromptLabel();
  showWelcome();

  // Run startup commands
  setTimeout(() => {
    writeLine(`PS ${state.cwd} > Get-Date`, 'line-prompt');
    CMDLETS['get-date']([], {}, null);
    writeLine('');
    document.getElementById('cmd-input')?.focus();
  }, 100);
}

document.addEventListener('DOMContentLoaded', init);
