import type { ReactNode } from "react";

export const settingsPageClass =
  "flex flex-col gap-6 w-full max-w-4xl mx-auto p-6";
export function SettingsPageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="sticky top-16 z-40 flex flex-wrap gap-4 justify-between items-center rounded-lg bg-background/95 py-3 backdrop-blur-sm">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-3xl font-bold bg-linear-to-r from-primary to-purple-500 bg-clip-text text-transparent">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="ml-auto shrink-0">{children}</div>
    </div>
  );
}
