const controllers = new Map<string, AbortController>();

export function registerPendingUserUploadController(id: string, controller: AbortController): void {
  controllers.set(id, controller);
}

export function clearPendingUserUploadController(id: string): void {
  controllers.delete(id);
}

export function abortPendingUserUpload(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  controllers.delete(id);
  return true;
}
