import "@capacitor/app";

declare module "@capacitor/app" {
  interface AppPlugin {
    openUrl(options: { url: string }): Promise<void>;
  }
}
