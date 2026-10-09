import { useUiStore } from '../../state/uiStore';
import { Icon, type IconName } from '../ui/Icon';

const TONE_ICON: Record<string, IconName> = {
  info: 'info',
  success: 'check-circle',
  warn: 'alert',
  error: 'x-circle',
};

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.level}`}>
          <span className="toast__icon">
            <Icon name={TONE_ICON[toast.level] ?? 'info'} size={15} />
          </span>
          <div className="toast__body">
            <p className="toast__title">{toast.title}</p>
            {toast.detail ? <p className="toast__detail">{toast.detail}</p> : null}
            {toast.action ? (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
          <button type="button" className="icon-btn icon-btn--ghost" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
