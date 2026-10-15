/** Map a click onto the contained Firefox image (top-centred), excluding its empty margins. */
export function browserPoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, viewport: { width: number; height: number }): { x: number; y: number } | null {
  if (viewport.width <= 0 || viewport.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  const x = clientX - box.left - (box.width - width) / 2;
  const y = clientY - box.top;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x: x / width, y: y / height };
}
