import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { useClickOutside, useFocusTrap } from '../../lib/hooks';

/* ------------------------------------------------------------------- modal */

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 460,
  dismissable = true,
  tone = 'default',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
  tone?: 'default' | 'danger';
}) {
  const ref = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div
        className={`modal modal--${tone}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <header className="modal__head">
          <div className="modal__titles">
            <h2 className="modal__title">{title}</h2>
            {subtitle ? <p className="modal__subtitle">{subtitle}</p> : null}
          </div>
          {dismissable ? (
            <button type="button" className="icon-btn icon-btn--ghost" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------- menu */

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect?: () => void;
}

export function Menu({
  x,
  y,
  items,
  onClose,
  minWidth = 208,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useClickOutside(ref, onClose);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);
    setPosition({ left, top });
  }, [x, y]);

  /** Enabled items in visual order — the roving focus only visits these. */
  const focusable = useMemo(
    () => items.map((item, index) => ({ item, index })).filter(({ item }) => item.label !== '-' && !item.disabled),
    [items],
  );

  const focusAt = useCallback(
    (slot: number) => {
      const node = ref.current;
      if (!node) return;
      const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button.menu__item:not(:disabled)'));
      if (buttons.length === 0) return;
      const wrapped = ((slot % buttons.length) + buttons.length) % buttons.length;
      buttons[wrapped]?.focus();
    },
    [],
  );

  useEffect(() => {
    // Move focus into the menu so it is reachable and operable from the keyboard.
    focusAt(0);
  }, [focusAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const node = ref.current;
      if (!node) return;
      const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('button.menu__item:not(:disabled)'));
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      if (event.key === 'Home') focusAt(0);
      else if (event.key === 'End') focusAt(buttons.length - 1);
      else if (event.key === 'ArrowDown') focusAt(current + 1);
      else focusAt(current - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, focusAt]);

  const handleSelect = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return;
      onClose();
      item.onSelect?.();
    },
    [onClose],
  );

  return createPortal(
    <div className="menu" ref={ref} style={{ left: position.left, top: position.top, minWidth }} role="menu">
      {items.map((item) =>
        item.label === '-' ? (
          <div key={item.id} className="menu__separator" role="separator" />
        ) : (
          <div key={item.id}>
            {item.separatorBefore ? <div className="menu__separator" role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`menu__item${item.tone === 'danger' ? ' is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => handleSelect(item)}
              tabIndex={-1}
            >
              <span className="menu__icon">{item.icon ? <Icon name={item.icon} size={14} /> : null}</span>
              <span className="menu__label">{item.label}</span>
              {item.shortcut ? <span className="menu__shortcut">{item.shortcut}</span> : null}
            </button>
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}
