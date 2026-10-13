"use client";
import { useEffect } from "react";

/**
 * On a phone the contact page's tab row scrolls sideways; this keeps the active tab (e.g. Merge or Details
 * opened from a link) in view instead of hidden past the right edge.
 */
export function ActiveTabIntoView({ active }: { active: string }) {
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Tabs"]');
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !el) return;
    const n = nav.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - 16;
  }, [active]);
  return null;
}
