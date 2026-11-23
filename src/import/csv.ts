// Minimal RFC 4180 CSV parser: quoted fields, "" escapes, commas and newlines
// inside quotes, CRLF or LF line endings, optional UTF-8 BOM, optional final newline.

export interface CsvRecord {
  /** 1-based line number where the record starts (header is line 1). */
  line: number;
  values: string[];
}

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

export function parseCsv(text: string): CsvRecord[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // distinguishes an empty last field from no field
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    values.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // Skip blank lines (a lone empty field).
    if (!(values.length === 1 && values[0] === "")) records.push({ line: recordLine, values });
    values = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== "") throw new CsvError("quote in the middle of an unquoted field", line);
      inQuotes = true;
      fieldStarted = true;
    } else if (c === ",") {
      endField();
      fieldStarted = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError("unterminated quoted field", recordLine);
  if (fieldStarted || field !== "" || values.length > 0) endRecord();
  return records;
}
