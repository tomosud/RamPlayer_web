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
  displayWidth: number; displayHeight: number;
  displayLeft: number; displayTop: number;
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

/** Maps the complete video to a movable, variable-size canvas in the UI stage. */
export function computeViewMapping(
  view: ViewState,
  sourceWidth: number,
  sourceHeight: number,
  _baseDisplayWidth: number,
  _baseDisplayHeight: number,
): ViewMapping | null {
  if (!finitePositive(view.scale) || !finitePositive(view.stageWidth) ||
      !finitePositive(view.stageHeight) || !finitePositive(view.dpr) ||
      !finitePositive(sourceWidth) || !finitePositive(sourceHeight) ||
      !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) return null;

  const displayWidth = sourceWidth * view.scale;
  const displayHeight = sourceHeight * view.scale;
  const renderScale = Math.min(
    view.dpr,
    sourceWidth / displayWidth,
    sourceHeight / displayHeight,
    3840 / displayWidth,
    2160 / displayHeight,
  );
  const canvasWidth = Math.max(1, Math.round(displayWidth * renderScale));
  const canvasHeight = Math.max(1, Math.round(displayHeight * renderScale));

  return {
    sx: 0,
    sy: 0,
    sw: sourceWidth,
    sh: sourceHeight,
    dx: 0,
    dy: 0,
    dw: canvasWidth,
    dh: canvasHeight,
    canvasWidth,
    canvasHeight,
    displayWidth,
    displayHeight,
    displayLeft: view.stageWidth / 2 + view.panX - displayWidth / 2,
    displayTop: view.stageHeight / 2 + view.panY - displayHeight / 2,
  };
}