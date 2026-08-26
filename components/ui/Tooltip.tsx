"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function Tooltip({ children, content, side = "top", align = "center" }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={4}
            style={{
              background: "rgba(18,18,28,0.95)",
              border: "1px solid rgba(126, 47, 208, 0.4)",
              padding: "0.5rem 0.75rem",
              borderRadius: "0.5rem",
              fontSize: "0.75rem",
              color: "#fff",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              maxWidth: "220px",
              lineHeight: 1.4,
              zIndex: 9999,
            }}
          >
            {content}
            <TooltipPrimitive.Arrow style={{ fill: "rgba(126, 47, 208, 0.4)" }} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
