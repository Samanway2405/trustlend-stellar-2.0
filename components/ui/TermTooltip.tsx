"use client";

/**
 * TermTooltip – accessible glossary tooltip for financial acronyms (Issue #264).
 *
 * Renders a small "i" affordance next to a term. Hovering or focusing it shows
 * a plain-language definition pulled from `lib/glossary/terms`.
 *
 * Accessibility notes:
 *  - The trigger is a real <button type="button">, so it is reachable with Tab
 *    and activates on Enter/Space. Radix opens the tooltip on focus as well as
 *    hover, and closes it on Escape or blur.
 *  - Radix removes its tooltip content from the accessibility tree while the
 *    tooltip is closed, so the full definition is also baked into the button's
 *    aria-label ("APR: Annual Percentage Rate — ..."). Screen-reader users get
 *    the explanation from the button itself, without depending on a hover-only
 *    interaction ever firing.
 *  - The icon glyph is aria-hidden so the label is not polluted with a stray
 *    "i", and the button is never announced as unlabelled.
 */

import { Tooltip } from "./Tooltip";
import {
  GLOSSARY,
  formatGlossaryDefinition,
  type GlossaryTermKey,
} from "@/lib/glossary/terms";

interface TermTooltipProps {
  /** Which glossary entry to explain. */
  term: GlossaryTermKey;
  /**
   * Render the acronym text alongside the icon. When false (the default) only
   * the icon renders, for use next to an existing label such as a table header.
   */
  showLabel?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Extra class on the wrapper, so call sites can control spacing. */
  className?: string;
}

export function TermTooltip({
  term,
  showLabel = false,
  side = "top",
  align = "center",
  className,
}: TermTooltipProps) {
  const entry = GLOSSARY[term];
  // Unknown key: render nothing rather than an empty tooltip with a dead
  // trigger that keyboard users would still have to tab through.
  if (!entry) return null;

  const definition = formatGlossaryDefinition(term);

  return (
    <span
      className={
        className ? `term-tooltip ${className}` : "term-tooltip"
      }
    >
      {showLabel && <span className="term-tooltip__label">{entry.label}</span>}

      <Tooltip
        side={side}
        align={align}
        content={
          <span className="term-tooltip__content">
            <strong className="term-tooltip__content-title">{entry.full}</strong>
            <span className="term-tooltip__content-body">{entry.description}</span>
          </span>
        }
      >
        <button
          type="button"
          className="term-tooltip__trigger"
          // Radix sets its own aria-describedby on the trigger while the
          // tooltip is open, so the permanent definition is exposed through
          // aria-label instead — that one is ours alone and is announced
          // whether or not the tooltip has been triggered.
          aria-label={`${entry.label}: ${definition}`}
          // The tooltip is purely informational — clicking should never submit
          // a form or bubble into a row/card click handler (e.g. the expandable
          // marketplace rows).
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <span aria-hidden="true">i</span>
        </button>
      </Tooltip>
    </span>
  );
}
