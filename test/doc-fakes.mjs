// Just enough of DocumentApp and DriveApp for Tailor.gs: documents as trees of
// paragraphs whose text keeps per-character attributes, copies, trash, and a
// PDF export whose page count grows with the amount of text.

export const ElementType = { PARAGRAPH: "PARAGRAPH", LIST_ITEM: "LIST_ITEM", TABLE: "TABLE", TABLE_ROW: "TABLE_ROW", TABLE_CELL: "TABLE_CELL" };

class FakeText {
  constructor(chars) { this.chars = chars; }
  getText() { return this.chars.map((c) => c.c).join(""); }
  getAttributes(i) { return { ...(this.chars[i]?.attrs || {}) }; }
  insertText(i, s) { this.chars.splice(i, 0, ...[...s].map((c) => ({ c, attrs: {} }))); return this; }
  deleteText(a, b) { this.chars.splice(a, b - a + 1); return this; }
  appendText(s) { return this.insertText(this.chars.length, s); }
  setAttributes(a, b, attrs) { for (let i = a; i <= b; i++) this.chars[i].attrs = { ...attrs }; return this; }
}

class FakePara {
  constructor(type, text, attrs = {}) { this.type = type; this.text = new FakeText([...text].map((c) => ({ c, attrs: { ...attrs } }))); }
  getType() { return this.type; }
  getText() { return this.text.getText(); }
  editAsText() { return this.text; }
  asParagraph() { return this; }
  asListItem() { return this; }
}

class FakeContainer {
  constructor(type, children) { this.type = type; this.children = children; }
  getType() { return this.type; }
  getNumChildren() { return this.children.length; }
  getChild(i) { return this.children[i]; }
  asTable() { return this; } asTableRow() { return this; } asTableCell() { return this; }
}

/** h("EXPERIENCE"), p("Amazon"), li("Built ...", {BOLD: true}), table([[ [els], [els] ]]) */
export const p = (t, a) => new FakePara(ElementType.PARAGRAPH, t, a);
export const li = (t, a) => new FakePara(ElementType.LIST_ITEM, t, a);
export const table = (rows) => new FakeContainer(ElementType.TABLE,
  rows.map((cells) => new FakeContainer(ElementType.TABLE_ROW, cells.map((els) => new FakeContainer(ElementType.TABLE_CELL, els)))));

const clone = (node) => {
  if (node instanceof FakePara) {
    const c = new FakePara(node.type, "");
    c.text = new FakeText(node.text.chars.map((x) => ({ c: x.c, attrs: { ...x.attrs } })));
    return c;
  }
  return new FakeContainer(node.type, node.children.map(clone));
};

const allText = (node) => node instanceof FakePara ? node.getText() + "\n" : node.children.map(allText).join("");

export function fakeDrive({ charsPerPage = 100000 } = {}) {
  const files = new Map();
  let n = 0;
  const id = () => `doc${String(++n).padStart(22, "0")}`;
  const file = (fid) => {
    const f = files.get(fid);
    return {
      getId: () => fid,
      getName: () => f.name,
      makeCopy: (name) => { const cid = id(); files.set(cid, { name, body: clone(f.body), trashed: false }); return file(cid); },
      setTrashed: (t) => { f.trashed = t; },
      getAs: () => ({ getDataAsString: () => `<< /Type /Pages /Kids [] /Count ${Math.max(1, Math.ceil(allText(f.body).length / charsPerPage))} >>` })
    };
  };
  return {
    files,
    add(name, children) { const fid = id(); files.set(fid, { name, body: new FakeContainer("BODY", children), trashed: false }); return fid; },
    text: (fid) => allText(files.get(fid).body),
    DriveApp: { getFileById: file, getFolderById: (x) => ({ x }) },
    DocumentApp: { ElementType, openById: (fid) => ({ getBody: () => files.get(fid).body, saveAndClose: () => {} }) }
  };
}
