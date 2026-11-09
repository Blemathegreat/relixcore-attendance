// CSV with protection against spreadsheet formula injection (=, +, -, @, tab, CR).
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}
