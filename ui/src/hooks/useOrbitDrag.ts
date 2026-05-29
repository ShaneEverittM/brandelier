import { useEffect, useRef } from 'react';
import type * as React from 'react';

import type { Camera } from '../types.ts';

export { type Options, type OrbitHandlers, useOrbitDrag };

type Options = {
  yawSensitivity?: number;
  tiltSensitivity?: number;
  onOrbitingChange?: (orbiting: boolean) => void;
};

type OrbitHandlers = {
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
};

function useOrbitDrag(
  camera: Camera,
  setCamera: (next: Camera) => void,
  options: Options = {},
): OrbitHandlers {
  const { yawSensitivity = 0.012, tiltSensitivity = 0.008, onOrbitingChange } = options;

  const activeRef = useRef<{
    onMove: (e: MouseEvent | TouchEvent) => void;
    onEnd: () => void;
  } | null>(null);

  useEffect(
    () => () => {
      const active = activeRef.current;
      if (!active) return;
      window.removeEventListener('mousemove', active.onMove);
      window.removeEventListener('mouseup', active.onEnd);
      window.removeEventListener('touchmove', active.onMove);
      window.removeEventListener('touchend', active.onEnd);
      window.removeEventListener('touchcancel', active.onEnd);
      activeRef.current = null;
    },
    [],
  );

  const startDrag = (startClientX: number, startClientY: number) => {
    onOrbitingChange?.(true);
    const start = { ...camera };

    const onMove = (e: MouseEvent | TouchEvent) => {
      if ('touches' in e) {
        if (e.cancelable) e.preventDefault();
        if (e.touches.length === 0) return;
      }
      const p = 'touches' in e ? e.touches[0] : e;
      const dx = p.clientX - startClientX;
      const dy = p.clientY - startClientY;
      setCamera(nextCamera(start, dx, dy, yawSensitivity, tiltSensitivity));
    };

    const onEnd = () => {
      onOrbitingChange?.(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      activeRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    activeRef.current = { onMove, onEnd };
  };

  return {
    onMouseDown: (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      e.stopPropagation();
      const touch = e.touches[0];
      if (!touch) return;
      startDrag(touch.clientX, touch.clientY);
    },
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
