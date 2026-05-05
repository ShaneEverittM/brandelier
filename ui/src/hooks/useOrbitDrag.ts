import { useEffect, useRef } from 'react';
import type * as React from 'react';

import type { Camera } from '../types.ts';

export { type Options, useOrbitDrag };

/** Options for {@link useOrbitDrag}. */
type Options = {
  /** The multiplier for yaw rotation applied to {@link React.MouseEvent.clientX} translations. */
  yawSensitivity?: number;

  /** The multiplier for tilt rotation applied to {@link React.MouseEvent.clientY} translations. */
  tiltSensitivity?: number;

  /** State tracking for if an orbit is in progress. */
  onOrbitingChange?: (orbiting: boolean) => void;
};

/**
 * A hook for controlling mouse drag behavior to rotate an orbiting camera.
 *
 * Install it with your other hooks and wire up the returned handler to "mousedown".
 *
 * @param camera the camera position
 * @param setCamera the callback to set the camera position when the mouse drags
 * @param options {@link Options}
 */
function useOrbitDrag(
  camera: Camera,
  setCamera: (next: Camera) => void,
  options: Options = {},
): (_: React.MouseEvent) => void {
  const { yawSensitivity = 0.012, tiltSensitivity = 0.008, onOrbitingChange } = options;

  // Track in-flight event handlers...
  const activeRef = useRef<{
    onMove: (_: MouseEvent) => void;
    onDragEnd: () => void;
  } | null>(null);

  // ...so we can clean them up if the calling component gets unmounted.
  useEffect(
    () => () => {
      const active = activeRef.current;
      if (!active) return;
      window.removeEventListener('mousemove', active.onMove);
      window.removeEventListener('mouseup', active.onDragEnd);
      activeRef.current = null;
    },
    [],
  );

  return (e: React.MouseEvent) => {
    // This is meant to be installed as a JSX mousedown handler,
    // so consider the event handled.
    e.stopPropagation();
    e.preventDefault();

    onOrbitingChange?.(true);

    // Capture location from the start of the drag.
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...camera };

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      const next = nextCamera(start, dx, dy, yawSensitivity, tiltSensitivity);
      setCamera(next);
    };

    // Clean up both event listeners on mouse release
    // and mark the orbit as complete.
    const onDragEnd = () => {
      onOrbitingChange?.(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onDragEnd);
      activeRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onDragEnd);
    activeRef.current = { onMove, onDragEnd };
  };
}

function nextCamera(
  start: Camera,
  dx: number,
  dy: number,
  yawSensitivity: number,
  tiltSensitivity: number,
): Camera {
  return {
    yaw: start.yaw + dx * yawSensitivity,
    elevation: clamp({ n: start.elevation + dy * tiltSensitivity, min: -1.0, max: 1.4 }),
  };
}

function clamp({ n, min, max }: { n: number; min: number; max: number }) {
  return Math.max(min, Math.min(n, max));
}
