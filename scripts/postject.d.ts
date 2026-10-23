declare module "postject" {
  export function inject(filename: string, resourceName: string, resourceData: Buffer, options?: { sentinelFuse?: string; machoSegmentName?: string; overwrite?: boolean }): Promise<void>;
}
