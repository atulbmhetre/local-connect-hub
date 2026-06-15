import type { NavigateFunction } from "react-router-dom";

let appNavigate: NavigateFunction | null = null;

export function setAppNavigate(navigate: NavigateFunction): void {
  appNavigate = navigate;
}

export function clearAppNavigate(): void {
  appNavigate = null;
}

export function getAppNavigate(): NavigateFunction | null {
  return appNavigate;
}
