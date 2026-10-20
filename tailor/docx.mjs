// A Word (.docx) file as the small part of Google's DocumentApp that
// Tailor.gs uses: a body of paragraphs, list items and tables, whose text can
// be edited a character at a time. Each character remembers which run (piece
// of formatting) it came from; on save, runs are rebuilt from those, so bold
// labels, fonts and sizes stay exactly where they were.
//
// Paragraphs with links, fields, pictures or tracked changes are left alone:
// they're reported with type LOCKED, which Tailor.gs skips.

import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export const ElementType = {
  PARAGRAPH: "PARAGRAPH", LIST_ITEM: "LIST_ITEM", TABLE: "TABLE", TABLE_ROW: "TABLE_ROW", TABLE_CELL: "TABLE_CELL", LOCKED: "LOCKED"
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const kids = (el) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1);
const isW = (el, name) => el.namespaceURI === W && el.localName === name;
const first = (el, name) => kids(el).find((k) => isW(k, name));

// Anything here inside a paragraph means rebuilding its runs could lose something.
const LOCKING = new Set(["hyperlink", "fldSimple", "drawing", "pict", "object", "ins", "del", "sdt", "smartTag",
  "fldChar", "instrText", "footnoteReference", "endnoteReference", "sym", "commentReference", "ruby"]);

function locked(p) {
  const walk = (el) => kids(el).some((k) => (k.namespaceURI === W && LOCKING.has(k.localName)) || walk(k));
  return walk(p);
}

/** Is this paragraph a list item? Directly numbered, or styled as a list ("ListBullet", "List Paragraph"). */
function isListItem(p) {
  const pPr = first(p, "pPr");
  if (!pPr) return false;
  if (first(pPr, "numPr")) return true;
  const style = first(pPr, "pStyle");
  return Boolean(style && /list/i.test(style.getAttributeNS(W, "val") || style.getAttribute("w:val") || ""));
}

class Text {
  constructor(para) { this.para = para; }
  get chars() { return this.para.chars; }
  getText() { return this.chars.map((c) => c.c).join(""); }
  getAttributes(i) { return { RUN: this.chars[i]?.run ?? null }; }
  insertText(i, s) {
    this.para.dirty = true;
    this.chars.splice(i, 0, ...[...s].map((c) => ({ c, run: null })));
    return this;
  }
  deleteText(a, b) { this.para.dirty = true; this.chars.splice(a, b - a + 1); return this; }
  appendText(s) { return this.insertText(this.chars.length, s); }
  setAttributes(a, b, attrs) {
    this.para.dirty = true;
    for (let i = a; i <= b && i < this.chars.length; i++) if (attrs.RUN !== undefined && attrs.RUN !== null) this.chars[i].run = attrs.RUN;
    return this;
  }
}

class Para {
  constructor(el) {
    this.el = el;
    this.type = locked(el) ? ElementType.LOCKED : isListItem(el) ? ElementType.LIST_ITEM : ElementType.PARAGRAPH;
    this.runs = kids(el).filter((k) => isW(k, "r"));
    this.chars = [];
    this.runs.forEach((r, k) => {
      for (const n of kids(r)) {
        if (isW(n, "t")) for (const c of n.textContent) this.chars.push({ c, run: k });
        else if (isW(n, "tab")) this.chars.push({ c: "\t", run: k });
        else if (isW(n, "br") || isW(n, "cr")) this.chars.push({ c: "\n", run: k });
        else if (isW(n, "noBreakHyphen")) this.chars.push({ c: "-", run: k });
      }
    });
    this.dirty = false;
    this.text = new Text(this);
  }
  getType() { return this.type; }
  getText() { return this.text.getText(); }
  editAsText() {
    if (this.type === ElementType.LOCKED) throw new Error("paragraph has links, fields or pictures; not edited");
    return this.text;
  }
  asParagraph() { return this; }
  asListItem() { return this; }

  /** Writes the characters back as runs, each copying the formatting of the run its first character came from. */
  save() {
    if (!this.dirty) return;
    const doc = this.el.ownerDocument;
    const anchor = this.runs[0] || null;
    const groups = [];
    for (const ch of this.chars) {
      const run = ch.run ?? groups.at(-1)?.run ?? 0;
      if (groups.length && groups.at(-1).run === run) groups.at(-1).text += ch.c;
      else groups.push({ run, text: ch.c });
    }
    const made = groups.map(({ run, text }) => {
      const r = doc.createElementNS(W, "w:r");
      const rPr = this.runs[run] && first(this.runs[run], "rPr");
      if (rPr) r.appendChild(rPr.cloneNode(true));
      for (const piece of text.split(/(\t|\n)/)) {
        if (!piece) continue;
        if (piece === "\t") r.appendChild(doc.createElementNS(W, "w:tab"));
        else if (piece === "\n") r.appendChild(doc.createElementNS(W, "w:br"));
        else {
          const t = doc.createElementNS(W, "w:t");
          t.setAttribute("xml:space", "preserve");
          t.appendChild(doc.createTextNode(piece));
          r.appendChild(t);
        }
      }
      return r;
    });
    for (const r of made) this.el.insertBefore(r, anchor);
    for (const old of this.runs) this.el.removeChild(old);
    this.runs = made;
    this.chars = [];
    made.forEach((r, k) => { for (const n of kids(r)) for (const c of (isW(n, "t") ? n.textContent : isW(n, "tab") ? "\t" : "\n")) this.chars.push({ c, run: k }); });
    this.dirty = false;
  }
}

class Container {
  constructor(el, type, paras) {
    this.el = el;
    this.type = type;
    this.children = [];
    // Content controls (w:sdt) wrap paragraphs in many templates; read through them.
    const add = (node) => {
      for (const k of kids(node)) {
        if (isW(k, "p")) { const p = new Para(k); paras.push(p); this.children.push(p); }
        else if (isW(k, "tbl")) this.children.push(new Container(k, ElementType.TABLE, paras));
        else if (isW(k, "tr")) this.children.push(new Container(k, ElementType.TABLE_ROW, paras));
        else if (isW(k, "tc")) this.children.push(new Container(k, ElementType.TABLE_CELL, paras));
        else if (isW(k, "sdt")) { const c = first(k, "sdtContent"); if (c) add(c); }
      }
    };
    add(el);
  }
  getType() { return this.type; }
  getNumChildren() { return this.children.length; }
  getChild(i) { return this.children[i]; }
  asTable() { return this; } asTableRow() { return this; } asTableCell() { return this; }
}

/** Opens a .docx: {body, save() -> Buffer}. */
export async function openDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("not a Word document (no word/document.xml)");
  const xml = new DOMParser().parseFromString(await file.async("string"), "application/xml");
  const bodyEl = Array.from(xml.getElementsByTagNameNS(W, "body"))[0];
  if (!bodyEl) throw new Error("Word document has no body");
  const paras = [];
  const body = new Container(bodyEl, "BODY", paras);
  return {
    body,
    async save() {
      for (const p of paras) p.save();
      zip.file("word/document.xml", new XMLSerializer().serializeToString(xml));
      return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    }
  };
}
