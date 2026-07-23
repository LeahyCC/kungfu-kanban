/* Minimal DOM stub sufficient to import and exercise public/js/board.js and
 * drawer.js under node --test (they are browser ESM importing document/window).
 * Supports: createElement, id-registry querySelector catch-all, classList,
 * dataset, attributes, tree ops (appendChild/insertBefore/removeChild/remove),
 * children/firstChild/nextSibling/parentNode, selector matching (tag, .cls,
 * #id, [attr], [data-x="y"], descendant combinator), closest/contains,
 * innerHTML setter that clears children (and counts writes, so tests can tell
 * "patched" from "reused"), focus/activeElement, scroll props, matchMedia
 * (reduced motion), a controllable rAF queue, and localStorage. */

'use strict';

let uid = 0;

class ClassList {
  constructor(el) { this.el = el; }
  _set() { return new Set(String(this.el.className).split(/\s+/).filter(Boolean)); }
  _write(s) { this.el.className = [...s].join(' '); }
  add(...cs) { const s = this._set(); cs.forEach((c) => s.add(c)); this._write(s); }
  remove(...cs) { const s = this._set(); cs.forEach((c) => s.delete(c)); this._write(s); }
  contains(c) { return this._set().has(c); }
  toggle(c, force) {
    const s = this._set();
    const want = force === undefined ? !s.has(c) : !!force;
    if (want) s.add(c); else s.delete(c);
    this._write(s);
    return want;
  }
}

function camel(name) { return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

function matchCompound(el, comp) {
  const re = /(^|[.#]?)([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  let matched = false;
  while ((m = re.exec(comp))) {
    if (m[3] !== undefined) {
      // attribute token
      const name = m[3];
      const val = m[4];
      let actual;
      if (name.startsWith('data-')) actual = el.dataset ? el.dataset[camel(name.slice(5))] : undefined;
      else actual = el.attributes ? el.attributes[name] : undefined;
      if (actual === undefined || actual === null) return false;
      if (val !== undefined && String(actual) !== val) return false;
      matched = true;
      continue;
    }
    const [, prefix, name] = m;
    if (!prefix) { if (el.tagName !== name.toUpperCase()) return false; }
    else if (prefix === '.') { if (!new ClassList(el).contains(name)) return false; }
    else if (prefix === '#') { if (el.id !== name) return false; }
    matched = true;
  }
  return matched;
}

function matchParts(el, parts, i) {
  if (!el || !el.tagName || el.tagName === '#DOCUMENT') return false;
  if (!matchCompound(el, parts[i])) return false;
  if (i === 0) return true;
  let p = el.parentNode;
  while (p) {
    if (matchParts(p, parts, i - 1)) return true;
    p = p.parentNode;
  }
  return false;
}

function matchSel(el, sel) {
  const parts = String(sel).trim().split(/\s+/);
  return matchParts(el, parts, parts.length - 1);
}

function qsa(root, sel) {
  const out = [];
  (function walk(n) {
    for (const c of n.children) {
      if (matchSel(c, sel)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

class El {
  constructor(tag) {
    this._uid = ++uid;
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this._listeners = {};
    this._innerHTML = '';
    this._innerHTMLWrites = 0;
    this.textContent = '';
    this.disabled = false;
    this.tabIndex = -1;
    this.value = '';
    this.checked = false;
    this.title = '';
    this.draggable = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get classList() { return new ClassList(this); }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this._innerHTMLWrites++;
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = this.children.indexOf(ref);
    if (i < 0) throw new Error('insertBefore: reference node not found');
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) { this.children.splice(i, 1); node.parentNode = null; }
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  }
  dispatch(type, ev) {
    ev = ev || {};
    ev.type = type;
    if (!ev.target) ev.target = this;
    ev.preventDefault = ev.preventDefault || (() => {});
    ev.stopPropagation = ev.stopPropagation || (() => {});
    for (const fn of (this._listeners[type] || []).slice()) fn(ev);
  }
  focus() { this.ownerDocument().activeElement = this; }
  ownerDocument() { let n = this; while (n.parentNode) n = n.parentNode; return n._doc || n; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.tagName === '#DOCUMENT';
  }
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  matches(sel) { return matchSel(this, sel); }
  closest(sel) {
    let n = this;
    while (n && n.tagName && n.tagName !== '#DOCUMENT') {
      if (matchSel(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelector(sel) { return qsa(this, sel)[0] || null; }
  querySelectorAll(sel) { return qsa(this, sel); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get offsetParent() { return this.parentNode; }
  get offsetLeft() { return 0; }
  get offsetTop() { return 0; }
  get offsetWidth() { return 0; }
  click() { this.dispatch('click', { target: this }); }
}

class Document extends El {
  constructor() {
    super('#document');
    this._doc = this;
    this.activeElement = null;
    this.visibilityState = 'visible';
    this.documentElement = new El('html');
    this.body = new El('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this._byId = new Map();
  }
  createElement(tag) { return new El(tag); }
  createElementNS(_, tag) { return new El(tag); }
  // '#id' hits a registry (auto-created + body-attached so module-level
  // $(...) wiring in the app modules always finds a node); other unmatched
  // selectors get a detached stub (module-level wiring tolerates it);
  // element-scoped querySelector still returns null for existence checks.
  querySelector(sel) {
    if (typeof sel === 'string' && sel.startsWith('#') && !sel.includes(' ')) {
      const id = sel.slice(1);
      let el = this._byId.get(id);
      if (!el) {
        el = new El('div');
        el.id = id;
        this._byId.set(id, el);
        this.body.appendChild(el);
      }
      return el;
    }
    return qsa(this, sel)[0] || new El('div');
  }
  querySelectorAll(sel) { return qsa(this, sel); }
}

function installFakeDom() {
  const document = new Document();
  const raf = {
    queue: [],
    flush() {
      const q = this.queue.splice(0);
      for (const cb of q) cb();
    },
  };
  const storage = new Map();
  const realSetInterval = globalThis.setInterval;

  globalThis.document = document;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.CSS = globalThis.CSS || { escape: (s) => String(s).replace(/(["\\])/g, '\\$1') };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (cb) => { raf.queue.push(cb); return raf.queue.length; };
  // chips.js starts module-level intervals; neuter them only during import
  globalThis.setInterval = () => 0;

  return {
    document,
    raf,
    El,
    // call after the ESM graph has been imported
    restoreTimers() { globalThis.setInterval = realSetInterval; },
  };
}

module.exports = { installFakeDom };
