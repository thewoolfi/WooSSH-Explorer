import { useEffect, useRef } from 'react';

/**
 * Global key handler. The combo is normalised to `mod+k`, `shift+delete`,
 * `escape`, `f2` … and ignored while the user types in a field unless
 * `allowInInput` is set.
 */
export function useHotkey(
  combo: string,
  handler: (event: KeyboardEvent) => void,
  options: { allowInInput?: boolean; enabled?: boolean } = {},
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (options.enabled === false) return;
    const listener = (event: KeyboardEvent) => {
      if (!options.allowInInput && isTextTarget(event.target)) {
        // Still allow plain Escape out of inputs.
        if (event.key !== 'Escape') return;
      }
      if (matchesCombo(event, combo)) {
        handlerRef.current(event);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [combo, options.allowInInput, options.enabled]);
}

export function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] as string;
  const wantMod = parts.includes('mod');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');

  const hasMod = event.ctrlKey || event.metaKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== event.shiftKey) return false;
  if (wantAlt !== event.altKey) return false;

  const eventKey = event.key.toLowerCase();
  if (key === 'space') return eventKey === ' ' || event.code === 'Space';
  if (key === 'delete') return eventKey === 'delete' || eventKey === 'backspace';
  if (key === 'escape') return eventKey === 'escape';
  if (key === 'enter') return eventKey === 'enter';
  // Arrow keys arrive as `ArrowUp`… so the friendly alias has to be translated
  // rather than compared directly.
  if (key === 'up') return eventKey === 'arrowup';
  if (key === 'down') return eventKey === 'arrowdown';
  if (key === 'left') return eventKey === 'arrowleft';
  if (key === 'right') return eventKey === 'arrowright';
  if (key === 'pageup' || key === 'pagedown') return eventKey === key;
  return eventKey === key;
}

/** Traps Tab inside a container while it is mounted (dialogs, menus). */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const container = ref.current;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const first = container.querySelector<HTMLElement>(selector);
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [active]);
  return ref;
}

/** Calls `handler` on a pointer press outside `ref`. */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  handler: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (event: MouseEvent) => {
      const node = ref.current;
      if (!node) return;
      if (event.target instanceof Node && !node.contains(event.target)) handler();
    };
    // `capture` so the menu closes before the underlying element reacts.
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [ref, handler, active]);
}
