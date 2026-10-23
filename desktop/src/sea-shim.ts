// The CLI modules import node:sea; the desktop app is never a single-executable build.
export const isSea = () => false;
export const getAsset = () => { throw new Error("No embedded assets in the desktop app"); };
