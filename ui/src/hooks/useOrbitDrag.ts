import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Camera } from '../types.ts';

type Options = {
  yawSensitivity?: number;
  tiltSensitivity?: number;
  onOrbitingChange?: (orbiting: boolean) => void;
};

export function useOrbitDrag(
  camera: Camera,
  setCamera: (next: Camera) => void,
  options: Options = {},
) {
  const { yawSensitivity = 0.012, tiltSensitivity = 0.008, onOrbitingChange } = options;

  return (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    onOrbitingChange?.(true);

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...camera };

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      setCamera({
        yaw: start.yaw + dx * yawSensitivity,
        elevation: Math.max(-1.0, Math.min(1.4, start.elevation + dy * tiltSensitivity)),
      });
    };

    const onUp = () => {
      onOrbitingChange?.(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}
