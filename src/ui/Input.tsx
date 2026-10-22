import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import styles from "./Input.module.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  mono?: boolean;
  /** `bare` drops the frame (for inputs embedded in popups / headers). */
  variant?: "framed" | "bare";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, variant = "framed", className, spellCheck = false, autoComplete = "off", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={spellCheck}
      autoComplete={autoComplete}
      autoCorrect="off"
      autoCapitalize="off"
      aria-invalid={invalid || undefined}
      className={clsx(styles.input, variant === "bare" ? styles.bare : styles.framed, mono && styles.mono, className)}
      {...rest}
    />
  );
});

export interface SearchToggle {
  id: string;
  icon: IconName | (string & {});
  title: string;
  shortcut?: string;
  pressed: boolean;
  onToggle: (pressed: boolean) => void;
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  leadingIcon?: IconName | (string & {}) | null;
  /** Trailing toggle buttons such as Match Case / Words / Regex. */
  toggles?: SearchToggle[];
  /** Extra trailing content (e.g. a result counter). */
  trailing?: ReactNode;
  clearable?: boolean;
  invalid?: boolean;
  size?: "normal" | "large";
  variant?: "framed" | "bare";
  className?: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  {
    value,
    onChange,
    leadingIcon = "search",
    toggles,
    trailing,
    clearable = true,
    invalid,
    size = "normal",
    variant = "framed",
    className,
    ...rest
  },
  ref,
) {
  return (
    <div
      className={clsx(
        styles.searchField,
        variant === "framed" && styles.framed,
        size === "large" && styles.large,
        invalid && styles.invalid,
        className,
      )}
      data-invalid={invalid || undefined}
    >
      {leadingIcon && <Icon name={leadingIcon} size={size === "large" ? 15 : 14} className={styles.leading} />}
      <input
        ref={ref}
        className={styles.searchInput}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {trailing}
      {clearable && value && (
        <IconButton icon="close" title="Clear" size="small" iconSize={12} tabIndex={-1} onClick={() => onChange("")} />
      )}
      {toggles?.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          title={t.title}
          shortcut={t.shortcut}
          size="small"
          pressed={t.pressed}
          onClick={() => t.onToggle(!t.pressed)}
        />
      ))}
    </div>
  );
});
