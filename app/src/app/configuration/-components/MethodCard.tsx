import { ChevronDown } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  icon: ReactNode;
  color: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  children: ReactNode;
}

export function MethodCard({
  title,
  icon,
  color,
  enabled,
  onToggle,
  expanded,
  onExpand,
  children,
}: Props) {
  const panelId = useId();
  return (
    <div
      className={cn(
        "rounded-xl border",
        expanded
          ? "bg-muted/20 border-primary/30"
          : "bg-background/50 border-border",
      )}
    >
      <div className="p-4 flex items-center gap-4">
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "w-10 h-10 shrink-0 rounded-lg bg-linear-to-br flex items-center justify-center",
              color,
            )}
          >
            {icon}
          </span>
          <span className="flex-1 min-w-0 grid gap-1">
            <span className="font-medium text-sm sm:text-base">{title}</span>
            <Badge
              variant={enabled ? "default" : "secondary"}
              className="w-fit text-[10px] h-4 px-1.5"
            >
              {enabled ? "Enabled" : "Disabled"}
            </Badge>
          </span>
          <ChevronDown
            className={cn(
              "w-4 h-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <Switch
          aria-label={`Enable ${title}`}
          checked={enabled}
          onCheckedChange={onToggle}
        />
      </div>
      <div id={panelId} hidden={!expanded} className="px-4 pb-4">
        {children}
      </div>
    </div>
  );
}
