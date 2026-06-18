// Minimal ambient types for heic-convert (the package ships none).
declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number; // 0..1, JPEG only
  }
  function convert(options: ConvertOptions): Promise<Buffer>;
  export default convert;
}
