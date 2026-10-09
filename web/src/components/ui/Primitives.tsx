import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/* ------------------------------------------------------------------ button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    block ? 'btn--block' : '',
    !children ? 'btn--icon-only' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={size === 'lg' ? 15 : 13} /> : icon ? <Icon name={icon} size={size === 'lg' ? 15 : 14} /> : null}
      {children ? <span className="btn__label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={size === 'lg' ? 15 : 14} /> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: number;
  variant?: 'ghost' | 'secondary' | 'danger';
  active?: boolean;
  badge?: number;
}

export function IconButton({
  icon,
  label,
  size = 16,
  variant = 'ghost',
  active = false,
  badge,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={['icon-btn', `icon-btn--${variant}`, active ? 'is-active' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      data-badge={badge ? String(badge) : undefined}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ------------------------------------------------------------------ inputs */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  suffix?: ReactNode;
  invalid?: boolean;
  mono?: boolean;
}

export function TextInput({ icon, suffix, invalid, mono, className, ...rest }: TextInputProps) {
  return (
    <span className={['input', invalid ? 'is-invalid' : '', mono ? 'is-mono' : '', className ?? ''].filter(Boolean).join(' ')}>
      {icon ? <Icon name={icon} size={14} className="input__icon" /> : null}
      <input className="input__field" {...rest} />
      {suffix ? <span className="input__suffix">{suffix}</span> : null}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  inline = false,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  inline?: boolean;
  /** Lets a field span the whole form grid. */
  className?: string;
}) {
  return (
    <div className={['field', inline ? 'field--inline' : '', className ?? ''].filter(Boolean).join(' ')}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field__control">{children}</div>
      {error ? (
        <p className="field__error">{error}</p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div className={`segmented segmented--${size}`} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segmented__item${option.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
          title={option.label}
        >
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- feedback ---- */

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StatusDot({ tone = 'slate', pulse = false }: { tone?: string; pulse?: boolean }) {
  return <span className={`status-dot status-dot--${tone}${pulse ? ' is-pulsing' : ''}`} aria-hidden="true" />;
}

export function Progress({
  value,
  max = 100,
  indeterminate = false,
  tone = 'accent',
}: {
  value: number;
  max?: number;
  indeterminate?: boolean;
  tone?: 'accent' | 'warn' | 'danger';
}) {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`progress progress--${tone}${indeterminate ? ' is-indeterminate' : ''}`} role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <span className="progress__bar" style={indeterminate ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={22} strokeWidth={1.25} />
      </span>
      <p className="empty__title">{title}</p>
      {detail ? <p className="empty__detail">{detail}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
