export interface ViewState {
  scale: number;
  panX: number;
  panY: number;
  stageWidth: number;
  stageHeight: number;
  dpr: number;
}

export interface ViewMapping {
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
  canvasWidth: number; canvasHeight: number;
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

export function computeViewMapping(
  view: ViewState,
  sourceWidth: number,
  sourceHeight: number,
  baseDisplayWidth: number,
  baseDisplayHeight: number,
): ViewMapping | null {
  if (!finitePositive(view.scale) || !finitePositive(view.stageWidth) ||
      !finitePositive(view.stageHeight) || !finitePositive(view.dpr) ||
      !finitePositive(sourceWidth) || !finitePositive(sourceHeight) ||
      !finitePositive(baseDisplayWidth) || !finitePositive(baseDisplayHeight) ||
      !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) return null;

  const dispW = baseDisplayWidth * view.scale;
  const dispH = baseDisplayHeight * view.scale;
  const rectL = view.stageWidth / 2 + view.panX - dispW / 2;
  const rectT = view.stageHeight / 2 + view.panY - dispH / 2;
  const left = Math.max(0, rectL);
  const top = Math.max(0, rectT);
  const right = Math.min(view.stageWidth, rectL + dispW);
  const bottom = Math.min(view.stageHeight, rectT + dispH);
  if (right <= left || bottom <= top) return null;

  const renderDpr = Math.min(view.dpr, 3840 / view.stageWidth, 2160 / view.stageHeight);
  return {
    sx: ((left - rectL) / dispW) * sourceWidth,
    sy: ((top - rectT) / dispH) * sourceHeight,
    sw: ((right - left) / dispW) * sourceWidth,
    sh: ((bottom - top) / dispH) * sourceHeight,
    dx: left * renderDpr,
    dy: top * renderDpr,
    dw: (right - left) * renderDpr,
    dh: (bottom - top) * renderDpr,
    canvasWidth: Math.max(1, Math.round(view.stageWidth * renderDpr)),
    canvasHeight: Math.max(1, Math.round(view.stageHeight * renderDpr)),
  };
}
