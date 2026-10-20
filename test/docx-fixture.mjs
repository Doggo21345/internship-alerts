// Builds small .docx files for tests: paragraphs as [text, {bold, list, runs, raw}].
import JSZip from "jszip";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text, bold) => `<w:r>${bold ? "<w:rPr><w:b/><w:sz w:val=\"21\"/></w:rPr>" : "<w:rPr><w:sz w:val=\"21\"/></w:rPr>"}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

export function para(text, { bold = false, list = false, runs = null, raw = null } = {}) {
  if (raw) return raw;
  const pPr = list ? '<w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : "";
  const body = runs ? runs.map(([t, b]) => run(t, b)).join("") : run(text, bold);
  return `<w:p>${pPr}${body}</w:p>`;
}

export const tableXml = (cells) => `<w:tbl><w:tr>${cells.map((ps) => `<w:tc>${ps.join("")}</w:tc>`).join("")}</w:tr></w:tbl>`;

export async function makeDocx(parts) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
    parts.join("") + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Paragraph texts and their runs' bold flags, read straight from the XML. */
export async function readDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml").async("string");
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p [^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => {
    const inner = m[1] ?? m[2];
    const runs = [...inner.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((r) => ({
      text: [...r[1].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(""),
      bold: /<w:b\/>/.test(r[1]), size: (r[1].match(/<w:sz w:val="(\d+)"/) || [])[1]
    }));
    return { text: runs.map((r) => r.text).join("").replace(/&amp;/g, "&"), runs, list: /<w:numPr>/.test(inner) };
  });
}
