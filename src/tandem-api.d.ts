import type { TandemApi } from "../shared/api";

declare global {
  interface Window {
    tandem: TandemApi;
    twindem: TandemApi;
  }
}

export {};
