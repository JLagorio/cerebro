/** Deterministic ASCII fixtures with byte-exact xrefs; no opaque binary source (CV-13). */
export function makePdf(
  options: { pages?: number; text?: boolean; outline?: boolean } = {},
): Uint8Array {
  const { pages = 1, text = true, outline = false } = options;
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageRefs: number[] = [];
  for (let page = 1; page <= pages; page++) {
    const id = objects.length + 1;
    pageRefs.push(id);
    const content = text
      ? `BT /F1 18 Tf 50 740 Td (Page ${page}${page === 33 ? ' quartz' : ''}) Tj ET\n`
      : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${pageRefs.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let outlineRef = '';
  if (outline) {
    const root = objects.length + 1;
    outlineRef = ` /Outlines ${root} 0 R`;
    objects.push(`<< /Type /Outlines /First ${root + 1} 0 R /Last ${root + 4} 0 R /Count 5 >>`);
    const rows = [
      ['Intro', 1],
      ['Methods', 10],
      ['Results', 20],
      ['Appendix', 35],
    ] as const;
    rows.forEach(([title, page], index) => {
      const previous = index > 0 ? ` /Prev ${root + index} 0 R` : '';
      const next = index < 3 ? ` /Next ${root + index + 2} 0 R` : '';
      const child = index === 2 ? ` /First ${root + 5} 0 R /Last ${root + 5} 0 R /Count 1` : '';
      objects.push(
        `<< /Title (${title}) /Parent ${root} 0 R /Dest [${pageRefs[Math.min(page, pages) - 1]} 0 R /Fit]${previous}${next}${child} >>`,
      );
    });
    objects.push(
      `<< /Title (Table 3) /Parent ${root + 3} 0 R /Dest [${pageRefs[Math.min(23, pages) - 1]} 0 R /Fit] >>`,
    );
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${outlineRef} >>`;
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
