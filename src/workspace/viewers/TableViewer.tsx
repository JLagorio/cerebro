import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { csvProblemText, parseCsv } from '@/engine/csv';
import { extOf } from '@/engine/fileKinds';
import { CodeViewer } from '../CodeViewer';
export function TableViewer({ path, content }: { path: string; content: string }) {
  const [header, setHeader] = useState(true);
  const [text, setText] = useState(false);
  const table = useMemo(
    () =>
      parseCsv(content, {
        maxRows: 1000,
        header,
        delimiter: ['tsv', 'tab'].includes(extOf(path) ?? '') ? '\t' : ',',
      }),
    [content, path, header],
  );
  const problem = table.problems[0];
  return (
    <div className="table-viewer" data-testid="table-viewer">
      <div className="file-viewer-controls">
        <Switch label="Header row" checked={header} onChange={setHeader} />
        <Button size="sm" variant="ghost" onClick={() => setText(!text)}>
          {text ? 'View as table' : 'View as text'}
        </Button>
        {!text && problem === undefined && (
          <span className="file-viewer-hint file-viewer-count">
            {table.rowCount > 1000
              ? `Showing the first 1,000 of ${table.rowCount.toLocaleString()} rows.`
              : `${table.rowCount} ${table.rowCount === 1 ? 'row' : 'rows'}`}
          </span>
        )}
      </div>
      {problem !== undefined && <p role="status">{csvProblemText(problem)}</p>}
      {text || problem !== undefined ? (
        <CodeViewer path={path} content={content} />
      ) : (
        <>
          <div className="file-table-scroll">
            <table>
              <thead>
                <tr>
                  {table.headers.map((name, i) => (
                    <th key={i} scope="col">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((value, c) => (
                      <td key={c}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
