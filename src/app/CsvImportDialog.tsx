import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { csvProblemText, type CsvTable } from '@/engine/csv';
import { inferKind, planCsvImport, viableKinds, type CsvKind } from '@/engine/csvImport';
import { kindMeta } from '@/engine/properties';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { columnNames, importCsv, nameProblem, readCsvFile } from './csvActions';

export function CsvImportDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((state) => state.entries);
  const vault = useVaultStore((state) => state.vaultPath);
  const initialVault = useRef(vault);
  const schema = useSchema();
  const fileInput = useRef<HTMLInputElement>(null);
  const readTicket = useRef(0);
  const [name, setName] = useState('');
  const [filename, setFilename] = useState('');
  const [table, setTable] = useState<CsvTable | null>(null);
  const [titleColumn, setTitleColumn] = useState(0);
  const [kinds, setKinds] = useState<CsvKind[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    if (vault !== initialVault.current) onClose();
  }, [vault, onClose]);
  useEffect(
    () => () => {
      readTicket.current++;
    },
    [],
  );

  const choose = async (file: File) => {
    const ticket = ++readTicket.current;
    setReading(true);
    setTable(null);
    setFailure(null);
    setFilename(file.name);
    const read = await readCsvFile(file);
    if (ticket !== readTicket.current) return;
    setReading(false);
    if (!read.ok) {
      setFailure(read.reason);
      return;
    }
    setName(
      file.name
        .replace(/\.csv$/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/^./, (letter) => letter.toUpperCase()),
    );
    setTable(read.table);
    setTitleColumn(0);
    setKinds(read.table.headers.map((_, col) => inferKind(read.table.rows.map((row) => row[col]))));
  };
  const columns = useMemo(
    () =>
      table === null
        ? []
        : columnNames(table.headers).map((name, index) => ({ name, kind: kinds[index] })),
    [table, kinds],
  );
  const draft = useMemo(
    () => (table === null ? null : { name: name.trim(), table, titleColumn, columns }),
    [name, table, titleColumn, columns],
  );
  const nameError = table === null ? null : nameProblem(name, entries, schema);
  const plan = useMemo(
    () => (draft === null || nameError !== null ? null : planCsvImport(draft, entries, schema)),
    [draft, nameError, entries, schema],
  );
  const problems =
    failure !== null ? [failure] : table === null ? [] : table.problems.map(csvProblemText);
  if (nameError !== null) problems.push(nameError);
  if (plan !== null && !plan.ok && !problems.includes(plan.reason)) problems.push(plan.reason);
  const submit = async () => {
    if (draft === null || plan?.ok !== true || problems.length > 0 || reading || writing) return;
    setWriting(true);
    const imported = await importCsv(draft);
    setWriting(false);
    if (imported !== null) onClose();
  };
  const selectClass = 'rounded-md border border-n-300 bg-n-0 px-2 py-1.5 text-sm text-n-800';
  return (
    <div data-testid="csv-import-dialog">
      <Dialog
        open
        title="Import CSV"
        width={720}
        onClose={writing ? undefined : onClose}
        primaryAction={{
          label: writing ? 'Importing…' : 'Import',
          testId: 'csv-import-submit',
          disabled:
            draft === null || plan?.ok !== true || problems.length > 0 || reading || writing,
          onClick: () => void submit(),
        }}
        secondaryAction={{ label: 'Cancel', disabled: writing, onClick: onClose }}
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm text-n-600">
            Create a database from a CSV. Choose the title column and check the property kinds
            before importing.
          </p>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              hidden
              data-testid="csv-file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void choose(file);
                event.target.value = '';
              }}
            />
            <Button
              icon="upload"
              disabled={reading || writing}
              onClick={() => fileInput.current?.click()}
            >
              Choose CSV
            </Button>
            <span className="min-w-0 truncate text-xs text-n-500">
              {reading ? 'Reading…' : filename}
            </span>
          </div>
          {table !== null && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs text-n-600">
                  Database name
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={writing}
                    width="100%"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-n-600">
                  Title column
                  <select
                    className={selectClass}
                    value={titleColumn}
                    disabled={writing}
                    onChange={(event) => setTitleColumn(Number(event.target.value))}
                  >
                    {table.headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="max-h-[280px] overflow-auto rounded-lg border border-n-200">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-n-25 text-xs text-n-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Column</th>
                      <th className="px-3 py-2 font-medium">Kind</th>
                      <th className="px-3 py-2 font-medium">Sample values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.headers.map((header, index) => (
                      <tr key={index} className="border-t border-n-100">
                        <td className="px-3 py-2 text-n-800">{header}</td>
                        <td className="px-3 py-2">
                          {index === titleColumn ? (
                            <span className="text-xs text-n-500">Title</span>
                          ) : (
                            <select
                              aria-label={`Kind for ${header}`}
                              className={selectClass}
                              value={kinds[index]}
                              disabled={writing}
                              onChange={(event) =>
                                setKinds((current) =>
                                  current.map((kind, col) =>
                                    col === index ? (event.target.value as CsvKind) : kind,
                                  ),
                                )
                              }
                            >
                              {viableKinds(table.rows.map((row) => row[index])).map((kind) => (
                                <option key={kind} value={kind}>
                                  {kindMeta(kind).label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="max-w-[240px] px-3 py-2 text-xs text-n-500">
                          <div className="line-clamp-3 whitespace-pre-wrap break-words">
                            {table.rows
                              .slice(0, 3)
                              .map((row) =>
                                row[index].length > 160
                                  ? row[index].slice(0, 160) + '…'
                                  : row[index],
                              )
                              .join(' · ')}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="m-0 text-xs text-n-600" role="status">
                {table.rowCount} {table.rowCount === 1 ? 'record' : 'records'}
                {table.blankRows > 0
                  ? ` · ${table.blankRows} blank ${table.blankRows === 1 ? 'row' : 'rows'} skipped`
                  : ''}
                {plan?.ok === true && plan.untitled > 0 ? ` · ${plan.untitled} untitled` : ''}
              </p>
            </>
          )}
          {problems.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700"
            >
              {problems.slice(0, 5).map((problem, index) => (
                <p key={index} className="m-0 py-0.5">
                  {problem}
                </p>
              ))}
              {problems.length > 5 && (
                <p className="m-0">And {problems.length - 5} more problems.</p>
              )}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
