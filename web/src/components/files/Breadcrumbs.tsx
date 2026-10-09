import { useEffect, useRef, useState } from 'react';
import { crumbsFor, type Crumb } from '../../lib/path';
import { Icon } from '../ui/Icon';

export function Breadcrumbs({
  path,
  home,
  onNavigate,
  editing,
  onEditingChange,
}: {
  path: string;
  home?: string;
  onNavigate: (path: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(path);
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 10);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [editing, path]);

  if (editing) {
    return (
      <form
        className="crumbs crumbs--editing"
        onSubmit={(event) => {
          event.preventDefault();
          onEditingChange(false);
          if (draft.trim()) onNavigate(draft.trim());
        }}
      >
        <Icon name="arrow-corner-up" size={13} className="crumbs__lead" />
        <input
          ref={inputRef}
          className="crumbs__input mono"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onEditingChange(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onEditingChange(false);
            }
          }}
          aria-label="Path"
        />
      </form>
    );
  }

  const crumbs: Crumb[] = crumbsFor(path);
  const collapsed = crumbs.length > 5;
  const visible: (Crumb | 'ellipsis')[] = collapsed
    ? [crumbs[0] as Crumb, 'ellipsis', ...crumbs.slice(-3)]
    : crumbs;

  return (
    <nav className="crumbs" aria-label="Path">
      {visible.map((crumb, index) =>
        crumb === 'ellipsis' ? (
          <span key="ellipsis" className="crumbs__sep" aria-hidden="true">
            <Icon name="dots" size={13} />
          </span>
        ) : (
          <span key={crumb.path} className="crumbs__group">
            {index > 0 ? (
              <span className="crumbs__sep" aria-hidden="true">
                <Icon name="chevron-right" size={12} />
              </span>
            ) : null}
            <button
              type="button"
              className={`crumb${index === visible.length - 1 ? ' is-current' : ''}`}
              onClick={() => onNavigate(crumb.path)}
              onDoubleClick={() => onEditingChange(true)}
              title={crumb.path}
            >
              {crumb.path === '/' ? <Icon name="drive" size={13} /> : null}
              <span>{crumb.path === '/' ? '/' : labelFor(crumb, home)}</span>
            </button>
          </span>
        ),
      )}
      <button
        type="button"
        className="crumbs__edit"
        aria-label="Edit path"
        onClick={() => onEditingChange(true)}
      >
        <Icon name="pencil" size={12} />
      </button>
    </nav>
  );
}

function labelFor(crumb: Crumb, home?: string): string {
  // The home directory is shown as `~` so deep paths stay readable, but the
  // filesystem root always reads as `/`.
  if (home && crumb.path === home && crumb.path !== '/') return '~';
  if (home && crumb.path.startsWith(`${home}/`)) return crumb.label;
  return crumb.label;
}
