declare module "*.png" {
  const source: string;
  export default source;
}

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const LIVE_PREVIEW_WORKER_WEBPACK_ENTRY: string;
