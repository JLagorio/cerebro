import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/** Development-only comparison of real shared primitives at exact pane widths.
 * No vault, saved preference or connector is read or written by this specimen. */
function CompositionLab() {
  const query = new URLSearchParams(window.location.search);
  const role = query.get('composition') === 'utility' ? 'utility' : 'collection';
  const proposed = query.get('variant') !== 'current';
  const requestedWidth = Number(query.get('width') ?? 600);
  const width = Number.isFinite(requestedWidth)
    ? Math.max(280, Math.min(1440, requestedWidth))
    : 600;
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const items = [
    'Launch readiness and release notes',
    'Research interviews',
    'A long page title that wraps while keeping the rest of the collection readable',
    'Design principles',
    'Weekly planning',
    'Customer feedback',
    'Engineering notes',
    'Team rituals',
    'Onboarding checklist',
    'Project decisions',
    'Archive',
    'Untitled page',
  ];
  const compositionProps = proposed ? { composition: role as 'collection' | 'utility' } : {};
  return (
    <main style={{ padding: 24, minHeight: '100vh', background: 'var(--surface-sunken)' }}>
      <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)' }}>
        Layout specimen · {proposed ? 'Proposed' : 'Current'} {role} · {width}px host
      </p>
      <section
        data-testid="composition-host"
        className={proposed ? 'cb-composition' : ''}
        style={{ width, maxWidth: '100%', background: 'var(--surface-app)' }}
      >
        <PageHeader
          {...compositionProps}
          title={role === 'collection' ? 'Team workspace' : 'Repair a connection'}
          description={
            role === 'collection'
              ? 'Shared plans, research and the decisions behind our work.'
              : 'Your saved work stays here while you check access.'
          }
          actions={
            <Button onClick={() => setNotice('Selected in the layout specimen.')} variant="primary">
              {role === 'collection' ? 'New page' : 'Check connection'}
            </Button>
          }
        />
        <div
          data-testid="composition-content"
          className={proposed ? 'cb-composition-content' : 'cb-surface-content'}
        >
          {role === 'collection' ? (
            <>
              <Input
                ariaLabel="Search pages"
                width="100%"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search pages"
              />
              <div style={{ marginTop: 16 }}>
                {items
                  .filter((item) => item.toLowerCase().includes(search.toLowerCase()))
                  .map((item) => (
                    <div
                      key={item}
                      style={{
                        padding: '12px 0',
                        minHeight: 48,
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      {item}
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <div style={{ maxWidth: 560 }}>
              <h2 className="cb-section-heading">Connection details</h2>
              <label htmlFor="specimen-account" style={{ display: 'block', marginBottom: 8 }}>
                Account label
              </label>
              <Input
                id="specimen-account"
                width="100%"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Research workspace"
              />
              <div className="cb-state-message" data-state="unavailable" style={{ marginTop: 16 }}>
                <div className="cb-state-message-content">
                  <p className="cb-state-message-title">Connection check unavailable</p>
                  <p className="cb-state-message-description">
                    The last check could not finish. Your account label and saved grants have been
                    kept.
                  </p>
                  <div className="cb-state-message-action">
                    <Button onClick={() => setNotice('Retry selected in the layout specimen.')}>
                      Retry check
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      </section>
    </main>
  );
}

export function mountCompositionLab(element: HTMLElement | null, dev: boolean) {
  if (!dev || !element) return;
  const theme =
    new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  createRoot(element).render(<CompositionLab />);
}
