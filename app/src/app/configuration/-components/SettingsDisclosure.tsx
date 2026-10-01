import { type ReactNode, useEffect, useState } from "react";

export function SettingsDisclosure({
  title,
  children,
  defaultOpen = false,
  hasErrors = false,
  className,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  hasErrors?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen || hasErrors);
  useEffect(() => {
    if (hasErrors) setOpen(true);
  }, [hasErrors]);
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium text-sm">
        {title}
        {hasErrors && (
          <span className="ml-2 text-xs text-destructive">Needs attention</span>
        )}
      </summary>
      {children}
    </details>
  );
}
