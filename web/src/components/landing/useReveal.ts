"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Fire-once scroll reveal: returns a ref to attach to the element and
 * `true` once it has scrolled into view. Stops observing after the first
 * trigger, so a card never re-hides on scroll-away. Under
 * `prefers-reduced-motion` the CSS transition this drives collapses to
 * ~0ms (globals.css), so the only visible effect is the content appearing
 * once rather than animating in.
 */
export function useReveal<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, visible];
}
