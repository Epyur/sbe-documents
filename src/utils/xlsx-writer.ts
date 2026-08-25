/** Минимальный writer .xlsx без внешних зависимостей.
 *  ZIP-архив в режиме stored (без сжатия) + CRC32; строки — inline strings.
 *  Excel/Power BI/Google Sheets открывают результат корректно. */

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

function zip(entries: Array<{ name: string; content: string }>): Uint8Array {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const fileRecords: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const prepared: ZipEntry[] = [];

  let offset = 0;
  for (const e of entries) {
    const data = utf8Bytes(e.content);
    const nameBytes = utf8Bytes(e.name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);      // version needed
    dv.setUint16(6, 0, true);       // flags
    dv.setUint16(8, 0, true);       // method = stored
    dv.setUint16(10, time, true);   // mod time
    dv.setUint16(12, date, true);   // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);      // extra len
    local.set(nameBytes, 30);

    fileRecords.push(local, data);
    prepared.push({ name: e.name, data, crc, offset });
    offset += local.length + data.length;
  }

  let cdSize = 0;
  for (const p of prepared) {
    const nameBytes = utf8Bytes(p.name);
    const rec = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);      // version made by
    dv.setUint16(6, 20, true);      // version needed
    dv.setUint16(8, 0, true);       // flags
    dv.setUint16(10, 0, true);      // method
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, p.crc, true);
    dv.setUint32(20, p.data.length, true);
    dv.setUint32(24, p.data.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);      // extra
    dv.setUint16(32, 0, true);      // comment
    dv.setUint16(34, 0, true);      // disk start
    dv.setUint16(36, 0, true);      // internal attr
    dv.setUint32(38, 0, true);      // external attr
    dv.setUint32(42, p.offset, true);
    rec.set(nameBytes, 46);
    central.push(rec);
    cdSize += rec.length;
  }

  const cdOffset = offset;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  return concat([...fileRecords, ...central, eocd]);
}

function escapeXml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Собирает .xlsx: первый лист «Реестр», header — строка заголовков, rows — данные.
 *  Значения вида целого числа записываются числом, остальные — текстом.
 *  links — опциональные кликабельные гиперссылки: { cell, url } (ячейка вида «C5»). */
export function buildXlsx(header: string[], rows: string[][], links?: Array<{ cell: string; url: string }>): Uint8Array {
  const numRe = /^-?\d+$/;
  const sheetRows: string[] = [];

  const headerCells = header.map((h, i) => {
    const ref = colLetter(i) + '1';
    return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(h)}</t></is></c>`;
  });
  sheetRows.push(`<row r="1">${headerCells.join('')}</row>`);

  rows.forEach((row, rIdx) => {
    const rNum = rIdx + 2;
    const cells = row.map((v, cIdx) => {
      const ref = colLetter(cIdx) + rNum;
      const val = v == null ? '' : String(v);
      if (numRe.test(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
    });
    sheetRows.push(`<row r="${rNum}">${cells.join('')}</row>`);
  });

  const hyperlinksEl = links && links.length > 0
    ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.cell}" r:id="rIdH${i + 1}"/>`).join('')}</hyperlinks>`
    : '';

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Реестр" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>${sheetRows.join('')}</sheetData>${hyperlinksEl}
</worksheet>`;

  const sheetRels = links && links.length > 0
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${links.map((l, i) => `<Relationship Id="rIdH${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(l.url)}" TargetMode="External"/>`).join('\n')}
</Relationships>`
    : '';

  const entries = [
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: styles },
    { name: 'xl/worksheets/sheet1.xml', content: sheet },
  ];
  if (sheetRels) {
    entries.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', content: sheetRels });
  }
  return zip(entries);
}
