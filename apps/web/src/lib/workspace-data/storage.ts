/**
 * Blob storage lives in @tugpt/workspace-core so the web app and the
 * knowledge/maintenance workers share one implementation (fs, S3-compatible,
 * memory). This module keeps the existing import path stable.
 */
export * from '@tugpt/workspace-core/storage';
