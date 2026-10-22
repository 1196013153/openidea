import { Icon } from "@/ui";
import { useDocMeta } from "../model/document";
import styles from "./EditorArea.module.css";

const TEXT = {
  binary: "This file appears to be binary and is shown read-only.",
  tooLarge: "The file is too large: editing and code insight are disabled.",
  readOnly: "The file is read-only.",
} as const;

/** Notice above read-only / binary / too-large documents. */
export function Banner({ path }: { path: string }) {
  const banner = useDocMeta((s) => s[path]?.banner ?? null);
  if (!banner) return null;
  return (
    <div className={styles.banner} role="status">
      <Icon name={banner === "readOnly" ? "lock" : "info"} size={14} className={styles.bannerIcon} />
      <span>{TEXT[banner]}</span>
    </div>
  );
}

/**
 * Notice above a library class opened from a language server (IDEA's
 * "Decompiled .class file" / library source bar): read-only, with its origin.
 */
export function VirtualBanner({ decompiled, description }: { decompiled: boolean; description: string | null }) {
  return (
    <div className={`${styles.banner} ${styles.libraryBanner}`} role="status">
      <Icon name={decompiled ? "info" : "lock"} size={14} className={styles.bannerIcon} />
      <span className={styles.bannerText}>
        {decompiled ? "Decompiled .class file: sources are not available." : "Library source (read-only)."}
      </span>
      {description && (
        <span className={styles.bannerDetail} title={description}>
          {description}
        </span>
      )}
    </div>
  );
}
