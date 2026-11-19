/**
 * Extraction and chunking live in @tugpt/workspace-core (shared with the
 * knowledge worker). The web app never loads the PDF engine: PDF extraction
 * is only available through `@tugpt/workspace-core/pdf` in the worker.
 */
export * from '@tugpt/workspace-core/extract';
export { readZipEntry, zipEntries } from '@tugpt/workspace-core/zip';
