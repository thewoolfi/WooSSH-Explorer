import { useCallback, useEffect, useRef, useState } from 'react';

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Drag-select: press on empty space, drag a rectangle, and everything it touches is
 * selected.
 *
 * The rectangle is drawn in the coordinate space of the scroll container's content, so it
 * stays attached to the rows while the list scrolls under it. Hit testing uses the rows'
 * own `getBoundingClientRect()` rather than arithmetic on row heights, because the
 * virtualised list mounts only the rows on screen and the two views have different row
 * geometry.
 *
 * A drag only begins on empty space — a press that lands on a row belongs to the row, and
 * the file list already uses that gesture for click, Shift-range and Ctrl-toggle.
 */
export function useMarquee({
  containerRef,
  itemSelector = '[data-path]',
  enabled = true,
  onPreview,
  onCommit,
  onClear,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Matches the selectable elements inside the container. */
  itemSelector?: string;
  enabled?: boolean;
  /** Called while dragging, with the paths the rectangle currently covers. */
  onPreview?: (paths: string[], additive: boolean) => void;
  /** Called once on release. `additive` means Ctrl was held, so the set is added to. */
  onCommit: (paths: string[], additive: boolean) => void;
  /** A press and release on empty space with no drag — the usual "deselect everything". */
  onClear?: () => void;
}): {
  rect: MarqueeRect | null;
  onMouseDown: (event: React.MouseEvent) => void;
} {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<{ x: number; y: number; additive: boolean } | null>(null);

  const hitTest = useCallback(
    (anchorX: number, anchorY: number, x: number, y: number): string[] => {
      const container = containerRef.current;
      if (container === null) return [];

      // In viewport coordinates, which is what the rows report too.
      const box = {
        left: Math.min(anchorX, x),
        right: Math.max(anchorX, x),
        top: Math.min(anchorY, y),
        bottom: Math.max(anchorY, y),
      };

      const hits: string[] = [];
      for (const node of container.querySelectorAll<HTMLElement>(itemSelector)) {
        const row = node.getBoundingClientRect();
        const overlaps =
          row.left < box.right &&
          row.right > box.left &&
          row.top < box.bottom &&
          row.bottom > box.top;
        if (overlaps) {
          const path = node.dataset.path;
          if (path !== undefined) hits.push(path);
        }
      }
      return hits;
    },
    [containerRef, itemSelector],
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled || event.button !== 0) return;
      const target = event.target as HTMLElement;
      // A press on a row, or on any control inside one, is not a drag.
      if (target.closest(itemSelector) !== null) return;
      if (target.closest('button, input, select, textarea, a, [role="button"]') !== null) return;

      dragRef.current = { x: event.clientX, y: event.clientY, additive: event.ctrlKey || event.metaKey };
    },
    [enabled, itemSelector],
  );

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      const container = containerRef.current;
      if (drag === null || container === null) return;

      // A few pixels of slack, so a plain click on empty space does not flash a rectangle
      // and clear the selection on the way past.
      const moved = Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y);
      if (rect === null && moved < 4) return;

      event.preventDefault();
      const bounds = container.getBoundingClientRect();
      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;

      // Drawn inside the scrolled content, so it moves with the rows.
      const toContent = (clientX: number, clientY: number) => ({
        x: clientX - bounds.left + scrollLeft,
        y: clientY - bounds.top + scrollTop,
      });
      const start = toContent(drag.x, drag.y);
      const end = toContent(event.clientX, event.clientY);

      setRect({
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      });
      onPreview?.(hitTest(drag.x, drag.y, event.clientX, event.clientY), drag.additive);
    };

    const onUp = (event: MouseEvent): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      const wasDragging = rect !== null;
      setRect(null);
      if (!wasDragging) {
        // Pressed and released on empty space without moving: clear, as a file manager does.
        onClear?.();
        return;
      }
      onCommit(hitTest(drag.x, drag.y, event.clientX, event.clientY), drag.additive);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, hitTest, onCommit, onPreview, onClear, rect]);

  return { rect, onMouseDown };
}
