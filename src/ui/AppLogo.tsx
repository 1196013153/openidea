import clsx from "clsx";
import markUrl from "../../src-tauri/icons/source/openidea-mark.svg";
import styles from "./AppLogo.module.css";

export interface AppLogoProps {
  /** Rendered edge length in CSS pixels. */
  size?: number;
  /** Accessible name; omit when the product name is shown next to the logo. */
  label?: string;
  className?: string;
}

/** The product mark (full-bleed tile variant, legible down to 16px). */
export function AppLogo({ size = 32, label, className }: AppLogoProps) {
  return (
    <img
      className={clsx(styles.logo, className)}
      src={markUrl}
      width={size}
      height={size}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  );
}
