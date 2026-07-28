import * as React from "react";
import { cn } from "@/lib/utils";

interface SegmentedProps {
  options: { value: string; label?: string; icon?: React.ReactNode; title?: string }[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
}

export function Segmented({ options, value, onChange, className }: SegmentedProps) {
  return (
    <div className={cn("inline-flex items-center rounded-md border bg-muted/40 p-0.5", className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-sm px-2 text-xs font-medium transition-colors",
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}